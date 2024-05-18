/* eslint-disable max-len */
/* eslint-disable guard-for-in */
/* eslint-disable max-depth */
/* eslint-disable strict */
'use strict';
const MAXBANDWIDTH = 25000;
const MAXBUFFER = 2;
const STATS_INTERVAL = 5;
const TASK_MAX = 0.0025;

const APPLY_PREFIX_MCU = [
  'mcu_awake', 'mcu_task_avg', 'mcu_task_stddev', 'bytes_write',
  'bytes_read', 'bytes_retransmit', 'freq', 'adj', 'srtt', 'rttvar',
  'rto', 'ready_bytes', 'upcoming_bytes'
];

const APPLY_PREFIX_HEATER = [
  'target', 'temp', 'pwm'
];

function parseLog(logData) {
  const applyPrefixMCU = APPLY_PREFIX_MCU.reduce((acc, p) => ({ ...acc, [p]: true }), {});
  const applyPrefixHeaters = APPLY_PREFIX_HEATER.reduce((acc, p) => ({ ...acc, [p]: true }), {});

  const lines = logData.split('\n');
  const parsedData = [];
  const events = { starts: [], shutdowns: [], ntj: [] };

  let pendingEvent = null;
  let previousSampleTime = null;
  let timeAdjustment = null;

  for (const line of lines) {
    if (line.startsWith('Stats')) {
      const parts = line.split(' ');
      const keyparts = { MCUs: {}, Heaters: {} };
      let currentPrefix = '';

      for (let i = 2; i < parts.length; i++) {
        if (!parts[i].includes('=')) {
          currentPrefix = parts[i].slice(0, -1);
          continue;
        }

        const [name, value] = parts[i].split('=');

        if ((name in applyPrefixMCU) && currentPrefix) {
          if (!keyparts.MCUs[currentPrefix]) {
            keyparts.MCUs[currentPrefix] = {};
          }
          keyparts.MCUs[currentPrefix][name] = value;
        } else if ((name in applyPrefixHeaters) && currentPrefix) {
          if (!keyparts.Heaters[currentPrefix]) {
            keyparts.Heaters[currentPrefix] = {};
          }
          keyparts.Heaters[currentPrefix][name] = value;
        } else {
          keyparts[name] = value;
        }
      }

      if (!keyparts.print_time) {
        continue;
      }

      let sampleTime = parseFloat(parts[1].slice(0, -1));

      if (previousSampleTime !== null && sampleTime < previousSampleTime) {
        events.ntj.push({ sampleTime: previousSampleTime, message: 'Negative time jump at: ' + previousSampleTime });
        timeAdjustment = previousSampleTime;
      }

      // Update previous sample time before adjusting the current sample time
      previousSampleTime = sampleTime;

      // Adjust sample time if there's a negative time jump
      if (timeAdjustment) {
        sampleTime += timeAdjustment;
      }

      keyparts['#sampletime'] = sampleTime;

      if (pendingEvent) {
        events[pendingEvent.type].push({ sampleTime, message: pendingEvent.line + ' (before: ' + sampleTime + ')' });
        pendingEvent = null;
      }

      parsedData.push(keyparts);
    } else if (line.startsWith('Start printer at') || line.startsWith('=============== Log rollover at')) {
      pendingEvent = { type: 'starts', line };
    } else if (line.startsWith('===== Config file =====')) {
      if (!pendingEvent || pendingEvent.type !== 'starts') {
        pendingEvent = { type: 'starts', line };
      }
    } else if (line.startsWith('Transition to shutdown state:')) {
      if (previousSampleTime !== null) {
        events.shutdowns.push({ sampleTime: previousSampleTime + timeAdjustment, message: line + ' (after: ' + previousSampleTime + ')' });
      }
    }
  }

  return { parsedData, events };
}


function findPrintRestarts(data) {
  const runoffSamples = {};
  let lastRunoffStart = 0;
  let lastBufferTime = 0;
  let lastSampletime = 0;
  let lastPrintStall = 0;

  for (let i = data.length - 1; i >= 0; i--) { // Iterate in reverse
    const d = data[i];

    // Buffer runoff check
    const sampletime = d['#sampletime'];
    const bufferTime = parseFloat(d.buffer_time || '0'); // Default to 0 if missing

    if (lastRunoffStart && lastSampletime - sampletime < 5 && bufferTime > lastBufferTime) {
      runoffSamples[lastRunoffStart][1].push(sampletime);
    } else if (bufferTime < 1) {
      lastRunoffStart = sampletime;
      runoffSamples[lastRunoffStart] = [false, [sampletime]];
    } else {
      lastRunoffStart = 0;
    }

    lastBufferTime = bufferTime;
    lastSampletime = sampletime;

    // Print stall check
    const printStall = parseInt(d['print_stall'], 10);

    if (printStall < lastPrintStall) {
      if (lastRunoffStart) {
        runoffSamples[lastRunoffStart][0] = true;
      }
    }
    lastPrintStall = printStall;
  }

  // Create sample resets object
  let sampleResets;

  sampleResets = {};
  sampleResets = Object.fromEntries(
    Object.entries(runoffSamples)
      .flatMap(([startTime, [stall, samples]]) => samples.filter((time) => !stall).map((time) => [time, 1]))
  );
  // console.log(sampleResets);
  
  return sampleResets;
}

function plotMCU(data, maxBandwidth) {
  const plotData = {};
  const previousSampleTimes = {};
  const negativeTimeDeltas = {};
  const timeJumpOffsets = {}; // Store time jump offsets per MCU
  // console.log(data);
  // console.log(data.parsedData);
  const basetime = data.parsedData[0]['#sampletime'];
  const sampleResets = findPrintRestarts(data.parsedData);

  for (const d of data.parsedData) {
    // console.log(d)
    // console.log(Object.keys(d.MCUs))
    const mcuPrefixes = Object.keys(d.MCUs);

    for (const mcuPrefix of mcuPrefixes) {
      if (!plotData[mcuPrefix]) {
        plotData[mcuPrefix] = {
          times: [],
          bwDeltas: [],
          loads: [],
          awake: [],
          hostBuffers: [],
          lastBW: parseFloat(data.parsedData[0]['MCUs'][mcuPrefix]['bytes_write']) + parseFloat(data.parsedData[0]['MCUs'][mcuPrefix]['bytes_retransmit'])
        };
      }

      // Calculation logic
      let currentSampleTime = d['#sampletime'];
    
      // Initialize previous sample time for this MCU
      if (!previousSampleTimes[mcuPrefix]) { 
        previousSampleTimes[mcuPrefix] = d['#sampletime'];
      }

      // Time consistency check and time jump offset calculation (per MCU)
      let timeDelta = 0;
    
      if (previousSampleTimes[mcuPrefix]) {
        timeDelta = currentSampleTime - previousSampleTimes[mcuPrefix];
        if (timeDelta < 0) { // First negative delta
          timeJumpOffsets[mcuPrefix] = previousSampleTimes[mcuPrefix]; // Store time jump offset for the MCU
          negativeTimeDeltas[mcuPrefix] = {
            times: [new Date((currentSampleTime + timeJumpOffsets[mcuPrefix]) * 1000)],
            bwDeltas: [0] // Use any available value
          };
        }
      }

      // Update previous sample time before time jump adjustment
      previousSampleTimes[mcuPrefix] = currentSampleTime; // Ensure correct delta for next iteration

      // Adjust current sample time and record negative time delta
      if (timeJumpOffsets[mcuPrefix]) {
        currentSampleTime += timeJumpOffsets[mcuPrefix];
      }

      const bw = parseFloat(d['MCUs'][mcuPrefix]['bytes_write']) + parseFloat(d['MCUs'][mcuPrefix]['bytes_retransmit']);

      if (bw < plotData[mcuPrefix].lastBW) {
        plotData[mcuPrefix].lastBW = bw;
        continue;
      }

      let load = parseFloat(d['MCUs'][mcuPrefix]['mcu_task_avg']) + (3 * parseFloat(d['MCUs'][mcuPrefix]['mcu_task_stddev']));

      if (currentSampleTime - basetime < 15) {
        load = 0; 
      }

      const pt = parseFloat(d['print_time']); 
      let hb = parseFloat(d['buffer_time']);

      if (hb >= MAXBUFFER || currentSampleTime in sampleResets) {
        hb = 0; 
      } else {
        hb = 100 * (MAXBUFFER - hb) / MAXBUFFER; 
      }

      // Directly update plotData
      plotData[mcuPrefix].times.push(new Date(currentSampleTime * 1000));
      plotData[mcuPrefix].bwDeltas.push(100 * (bw - plotData[mcuPrefix].lastBW) / (maxBandwidth * timeDelta));
      plotData[mcuPrefix].loads.push(100 * load / TASK_MAX);
      plotData[mcuPrefix].awake.push(100 * parseFloat(d['MCUs'][mcuPrefix]['mcu_awake'] || '0') / STATS_INTERVAL);
      plotData[mcuPrefix].hostBuffers.push(hb);

      plotData[mcuPrefix].lastBW = bw;
    }
  }
  // console.log(plotData);
  // Graph creation
  const plotDiv1 = document.getElementById('plotDiv1');

  plotDiv1.innerHTML = '';

  // Convert event keys to Date objects
  const eventTimes = Object.keys(data.events).map((eventType) => ({
    eventType,
    events: data.events[eventType].map((event) => ({
      time: new Date(parseFloat(event.sampleTime) * 1000),
      message: event.message
    }))
  }));

  for (const mcuPrefix in plotData) {
    // Create traces for this MCU
    const traces = [
      {
        x: plotData[mcuPrefix].times,
        y: plotData[mcuPrefix].bwDeltas,
        name: `Bandwidth - ${mcuPrefix}`,
        type: 'scatter',
        mode: 'lines',
        line: { color: 'blue' }
      },
      {
        x: plotData[mcuPrefix].times,
        y: plotData[mcuPrefix].loads,
        name: `MCU Load - ${mcuPrefix}`,
        type: 'scatter',
        mode: 'lines',
        line: { color: 'orange' }
      },
      {
        x: plotData[mcuPrefix].times,
        y: plotData[mcuPrefix].hostBuffers,
        name: `MCU Host Buffers - ${mcuPrefix}`,
        type: 'scatter',
        mode: 'lines',
        line: { color: 'cyan' }
      },
      {
        x: plotData[mcuPrefix].times,
        y: plotData[mcuPrefix].awake,
        name: `MCU Awake Time - ${mcuPrefix}`,
        type: 'scatter',
        mode: 'lines',
        line: { color: 'yellow' }
      }
    ];

    const plotDiv = document.createElement('div');

    plotDiv.id = `plotDiv_${mcuPrefix}`;
    plotDiv1.appendChild(plotDiv);

    const layout = {
      title: `MCU Bandwidth and Load Utilization - ${mcuPrefix}`,
      xaxis: { tickformat: '%H:%M', title: 'Time' },
      yaxis: { title: 'Usage (%)' },
      font: { size: 12 },
      legend: { orientation: 'h' },
      grid: { columns: 1, pattern: 'independent', rows: 1 },
      annotations: [], // Initialize shapes array
      shapes: [] // Initialize shapes array
    };

    eventTimes.forEach((event) => {
      event.events.forEach((evt) => {
        let eventTypeText;
        let arrowcolor;

        switch (event.eventType) {
          case 'starts':
            arrowcolor = 'green';
            eventTypeText = 'Start';
            break;
          case 'shutdowns':
            arrowcolor = 'red';
            eventTypeText = 'Shutdown';
            break;
          case 'ntj':
            arrowcolor = 'black';
            eventTypeText = 'Negative time jump';
            break;
        }

        /*
            layout.shapes.push({
                type: 'line',
                x0: evt.time,
                x1: evt.time,
                yref: 'paper',
                y0: 0,
                y1: 1,
                line: {
                    color: shapeColor,
                    width: 2,
                    dash: 'dot'
                }
            });
*/			
        layout.annotations.push({
          x: evt.time,
          y: 0, // Anchor the annotation to the x-axis (y = 0)
          yref: 'paper', 
          ayref: 'paper',
          ax: 0, 
          ay: 1, // Set the arrow length to 1, spanning the entire y-axis
          arrowside: 'start',
          arrowcolor,
          hovertext: evt.message,
          showarrow: true,
          bgcolor: 'rgba(0, 0, 0, 0)'
        });
      });
    });

    Plotly.newPlot(plotDiv, traces, layout, { responsive: true });
  }
}

function plotSystem(data) {
  const basetime = data.parsedData[0]['#sampletime'];
  let lasttime = basetime;
  let lastCPUTime = parseFloat(data.parsedData[0]['cputime']);

  const times = [];
  const sysLoads = [];
  const cpuTimes = [];
  const memAvails = [];

  for (const d of data.parsedData) {
    // console.log('plotSystem - d of data.parsedData:', d, typeof d);
    const st = d['#sampletime'];
    const timedelta = st - lasttime;

    if (timedelta <= 0) {
      continue; 
    }

    lasttime = st;
    const cpuTime = parseFloat(d['cputime']);
    const cpuDelta = Math.max(0, Math.min(1.5, (cpuTime - lastCPUTime) / timedelta));

    lastCPUTime = cpuTime;

    times.push(new Date(st * 1000));
    // console.log('plotSystem - times:', times, typeof times);
    sysLoads.push(parseFloat(d['sysload']) * 100);
    // console.log('plotSystem - sysLoads:', sysLoads, typeof sysLoads);
    cpuTimes.push(cpuDelta * 100);
    // console.log('plotSystem - cpuTimes:', cpuTimes, typeof cpuTimes);
    memAvails.push(parseFloat(d['memavail']));
    // console.log('plotSystem - memAvails:', memAvails, typeof memAvails);
  }

  // Plotly Setup
  const traces = [
    {
      x: times,
      y: sysLoads,
      name: 'System Load',
      type: 'scatter',
      mode: 'lines',
      line: { color: 'cyan' }
    },
    {
      x: times,
      y: cpuTimes,
      name: 'Process Time',
      type: 'scatter',
      mode: 'lines',
      line: { color: 'orange' }
    },
    {
      x: times,
      y: memAvails,
      name: 'System Memory',
      type: 'scatter',
      mode: 'lines',
      line: { color: 'yellow' },
      yaxis: 'y2'
    }
  ];

  const layout = {
    title: 'System load utilization',
    xaxis: { title: 'Time', tickformat: '%H:%M' },
    yaxis: { title: 'Load (% of a core)' },
    yaxis2: { title: 'Available memory (KB)', overlaying: 'y', side: 'right', position: 0.97, showgrid: false },
    font: { size: 12 },
    legend: { orientation: 'h' },
    grid: { rows: 1, columns: 1, pattern: 'independent' },
    annotations: [], // Initialize shapes array
    shapes: [] // Initialize shapes array
  };

  const eventTimes = Object.keys(data.events).map((eventType) => ({
    eventType,
    events: data.events[eventType].map((event) => ({
      time: new Date(parseFloat(event.sampleTime) * 1000),
      message: event.message
    }))
  }));
  
  eventTimes.forEach((event) => {
    event.events.forEach((evt) => {
      let eventTypeText;
      let arrowcolor;

      switch (event.eventType) {
        case 'starts':
          arrowcolor = 'green';
          eventTypeText = 'Start';
          break;
        case 'shutdowns':
          arrowcolor = 'red';
          eventTypeText = 'Shutdown';
          break;
        case 'ntj':
          arrowcolor = 'black';
          eventTypeText = 'Negative time jump';
          break;
      }
    
      layout.annotations.push({
        x: evt.time,
        y: 0, // Anchor the annotation to the x-axis (y = 0)
        yref: 'paper', 
        ayref: 'paper',
        ax: 0, 
        ay: 1, // Set the arrow length to 1, spanning the entire y-axis
        arrowside: 'start',
        arrowcolor,
        hovertext: evt.message,
        showarrow: true,
        bgcolor: 'rgba(0, 0, 0, 0)'
      });
    });
  });
  
  Plotly.newPlot('plotDiv2', traces, layout, { responsive: true });
}

function plotMCUFrequencies(data) {
  // Collect and Filter Keys
  const graphKeys = {};

  for (const d of data.parsedData) {
    const mcuPrefixes = Object.keys(d.MCUs);

    for (const mcuPrefix of mcuPrefixes) {
      const mcuData = d.MCUs[mcuPrefix];

      for (const key in mcuData) {
        const fullKey = `${mcuPrefix}:${key}`;

        if (key === 'freq' || key === 'adj') {
          if (!graphKeys[fullKey]) {
            graphKeys[fullKey] = [[], []];
          }

          const [times, values] = graphKeys[fullKey];
          const st = new Date(d['#sampletime'] * 1000);
          const val = mcuData[key];

          if (val !== undefined && val !== '0' && val !== '1') {
            times.push(st);
            values.push(parseFloat(val));
          }
        }
      }
    }
  }

  // Calculate Estimated MHz
  const estMhz = {};

  for (const key in graphKeys) {
    const [times, values] = graphKeys[key];
    const mhz = Math.round(values.reduce((acc, val) => acc + val, 0) / values.length / 1000000);

    estMhz[key] = mhz;
  }

  // Build Sorted Plotly Data
  const plotData = Object.keys(graphKeys).sort()
    .map((key) => {
      const [times, values] = graphKeys[key];
      const mhz = estMhz[key];
      const label = `${key} (${mhz}MHz)`;
      const hz = mhz * 1000000;

      
      return {
        x: times,
        y: values.map((v) => (v - hz) / mhz),
        name: label,
        type: 'scatter',
        mode: 'markers'
      };
    });

  // Plotly Setup
  const layout = {
    title: 'MCU Frequencies',
    xaxis: { title: 'Time', tickformat: '%H:%M' },
    yaxis: { title: 'Microsecond Deviation' },
    font: { size: 12 },
    legend: { orientation: 'h' },
    grid: { rows: 1, columns: 1, pattern: 'independent' },
    annotations: [], // Initialize shapes array
    shapes: [] // Initialize shapes array
  };

  const eventTimes = Object.keys(data.events).map((eventType) => ({
    eventType,
    events: data.events[eventType].map((event) => ({
      time: new Date(parseFloat(event.sampleTime) * 1000),
      message: event.message
    }))
  }));

  eventTimes.forEach((event) => {
    event.events.forEach((evt) => {
      let eventTypeText;
      let arrowcolor;

      switch (event.eventType) {
        case 'starts':
          arrowcolor = 'green';
          eventTypeText = 'Start';
          break;
        case 'shutdowns':
          arrowcolor = 'red';
          eventTypeText = 'Shutdown';
          break;
        case 'ntj':
          arrowcolor = 'black';
          eventTypeText = 'Negative time jump';
          break;
      }
    
      layout.annotations.push({
        x: evt.time,
        y: 0, // Anchor the annotation to the x-axis (y = 0)
        yref: 'paper', 
        ayref: 'paper',
        ax: 0, 
        ay: 1, // Set the arrow length to 1, spanning the entire y-axis
        arrowside: 'start',
        arrowcolor,
        hovertext: evt.message,
        showarrow: true,
        bgcolor: 'rgba(0, 0, 0, 0)'
      });
    });
  });
  
  Plotly.newPlot('plotDiv3', plotData, layout);
}

function plotTemperature(data) {
  const heaterData = {};
  const negativeTimeDeltas = {};

  for (const d of data.parsedData) {
    const heaters = Object.keys(d.Heaters);

    for (const heater of heaters) {
      if (!heaterData[heater]) {
        heaterData[heater] = {
          heater,
          times: [],
          temps: [],
          targets: [],
          pwms: []
        };
      }

      const heaterValues = d.Heaters[heater];
      const currentSampleTime = d['#sampletime'];

      // Store the data with the corrected timestamp
      heaterData[heater].times.push(new Date(currentSampleTime * 1000));
      heaterData[heater].temps.push(parseFloat(heaterValues.temp));
      heaterData[heater].targets.push(parseFloat(heaterValues.target) || 0);
      heaterData[heater].pwms.push(parseFloat(heaterValues.pwm) || 0);
    }
  }

 
  // Create divs and plot for each heater
  const plotDiv4 = document.getElementById('plotDiv4');

  plotDiv4.innerHTML = '';
  
  const eventTimes = Object.keys(data.events).map((eventType) => ({
    eventType,
    events: data.events[eventType].map((event) => ({
      time: new Date(parseFloat(event.sampleTime) * 1000),
      message: event.message
    }))
  }));
  
  for (const heaterInfo of Object.values(heaterData)) {
    const heaterDiv = document.createElement('div');

    heaterDiv.id = `plot_${heaterInfo.heater}`;
    plotDiv4.appendChild(heaterDiv);

    const traces = [
      {
        x: heaterInfo.times,
        y: heaterInfo.temps,
        name: `${heaterInfo.heater} Temp`,
        type: 'scatter',
        mode: 'lines',
        line: { color: 'orange' }
      }
    ];

    if (heaterInfo.targets.some(Boolean)) {
      traces.push({
        x: heaterInfo.times,
        y: heaterInfo.targets,
        name: `${heaterInfo.heater} Target`,
        type: 'scatter',
        mode: 'lines',
        line: { color: 'blue' }
      });
    }

    if (heaterInfo.pwms.some(Boolean)) {
      traces.push({
        x: heaterInfo.times,
        y: heaterInfo.pwms,
        name: `${heaterInfo.heater} PWM`,
        type: 'scatter',
        mode: 'lines',
        line: { color: 'darkgray', width: 0.8, opacity: 0.5, dash: 'dash' },
        yaxis: 'y2' // Plot on secondary y-axis
      });
    }

    // Create layout with secondary y-axis and annotations
    const layout = {
      title: heaterInfo.heater,
      showlegend: true,
      yaxis: { title: 'Temperature' },
      yaxis2: {
        title: 'PWM',
        overlaying: 'y',
        side: 'right'
      },
      annotations: [], // Initialize shapes array
      shapes: [] // Initialize shapes array
    };


    eventTimes.forEach((event) => {
      event.events.forEach((evt) => {
        let eventTypeText;
        let arrowcolor;

        switch (event.eventType) {
          case 'starts':
            arrowcolor = 'green';
            eventTypeText = 'Start';
            break;
          case 'shutdowns':
            arrowcolor = 'red';
            eventTypeText = 'Shutdown';
            break;
          case 'ntj':
            arrowcolor = 'black';
            eventTypeText = 'Negative time jump';
            break;
        }
    
        layout.annotations.push({
          x: evt.time,
          y: 0, // Anchor the annotation to the x-axis (y = 0)
          yref: 'paper', 
          ayref: 'paper',
          ax: 0, 
          ay: 1, // Set the arrow length to 1, spanning the entire y-axis
          arrowside: 'start',
          arrowcolor,
          hovertext: evt.message,
          showarrow: true,
          bgcolor: 'rgba(0, 0, 0, 0)'
        });
      });
    });
  
    Plotly.newPlot(`plot_${heaterInfo.heater}`, traces, layout);
  }
}


$(document).ready(() => {
  document.getElementById('buttonProcess').addEventListener('click', () => {
    const fileInput = document.getElementById('fileInput');

    if (fileInput.files.length > 0) {
      const file = fileInput.files[0];
      const reader = new FileReader();

      reader.onload = function(event) {
        const logData = event.target.result;
        const parsedData = parseLog(logData);

        plotMCU(parsedData, MAXBANDWIDTH);
        plotSystem(parsedData);
        plotMCUFrequencies(parsedData);
        plotTemperature(parsedData);
      };

      reader.readAsText(file);
    } else {
      alert('Please select a log file');
    }
  });
});
