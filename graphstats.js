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
  const events = { starts: [], shutdowns: [], calculatedBaseTimes: [] };

  let baseTimeStamp = null;
  let baseTimeStampOffset = null;
  let skippedStats = [];
  let lastSampleTime = null;
  let rolloverAdjustment = 0;
  let applyRolloverAdjustment = false;

  // Parse the Stats line and extract the data
  function parseStatsLine(line) {
    const parts = line.split(' ');
    const statsTimestamp = parseFloat(parts[1].slice(0, -1));
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
      return null;
    }

    return { lineData: keyparts, statsTimestamp };
  }

  // Apply the logic for the timestamps to the parsed lines
  function processStatsLine(parsedLine) {
    const { lineData, statsTimestamp } = parsedLine;
    const adjustment = applyRolloverAdjustment ? rolloverAdjustment : 0;
    const sampleTime = baseTimeStamp - baseTimeStampOffset + adjustment + statsTimestamp;

    lastSampleTime = sampleTime;

    lineData['#sampletime'] = sampleTime;
    lineData['#original_sampletime'] = statsTimestamp;
    lineData['#basetime'] = baseTimeStamp;

    parsedData.push(lineData);
  }

  // If log does not start with an useable time source
  // skip the steps and reprocess once time is available
  function processSkippedStats() {
    if (skippedStats.length > 0) {
      const maxStatsTimestamp = Math.max(...skippedStats.map((s) => s.statsTimestamp));
      const calculatedBaseTime = baseTimeStamp - baseTimeStampOffset - maxStatsTimestamp;

      // events.calculatedBaseTimes.push({ sampleTime: calculatedBaseTime, message: 'Calculated base time' });

      skippedStats.forEach((stat) => {
        const sampleTime = calculatedBaseTime + stat.statsTimestamp;

        stat.lineData['#sampletime'] = sampleTime;
        stat.lineData['#original_sampletime'] = stat.statsTimestamp;
        stat.lineData['#basetime'] = calculatedBaseTime;

        parsedData.push(stat.lineData);
      });
      skippedStats = [];
    }
  }

  for (const line of lines) {
    if (line.startsWith('Stats')) {
      const parsedLine = parseStatsLine(line);

      if (!parsedLine) {
        continue;
      }

      // No time source yet available
      if (baseTimeStamp === null) {
        skippedStats.push(parsedLine);
      } else {
        // On a log roll-over all follwoing stats lines will start at the 
        // roll over date. Adjustment is taken from the first "Stats" line
        // after the roll-over
        if (applyRolloverAdjustment && rolloverAdjustment === 0) {
          rolloverAdjustment = -parsedLine.statsTimestamp;
        }
        processStatsLine(parsedLine);
      }
    // The most accurate source for a timestamp is the "Printer start at" event
    } else if (line.startsWith('Start printer at')) {
      const match = line.match(/at\s+(.*) \((\d+\.\d+)\s+(\d+\.\d+)\)/);

      if (match) {
        baseTimeStamp = parseFloat(match[2]);
        baseTimeStampOffset = parseFloat(match[3]);
        rolloverAdjustment = 0; // Reset rollover adjustment
        applyRolloverAdjustment = false; // Disable applying rollover adjustment
        processSkippedStats();
      }
      events.starts.push({ sampleTime: baseTimeStamp, message: line });
    // Log roll-over only contains a time & date but no monotonic offset
    // Often and unfortunately the only usable time source at the beginning
    // of the log.
    } else if (line.startsWith('=============== Log rollover at')) {
      const match = line.match(/at\s+(.*) =+/);

      if (match) {
        baseTimeStamp = new Date(match[1]).getTime() / 1000;
        baseTimeStampOffset = 0; // No offset in log rollover case
        rolloverAdjustment = 0; // Reset rollover adjustment for now
        applyRolloverAdjustment = true; // Enable applying rollover adjustment
        processSkippedStats();
      }
      events.starts.push({ sampleTime: baseTimeStamp, message: line });
    } else if (line.startsWith('Transition to shutdown state:')) {
      if (baseTimeStamp !== null && lastSampleTime !== null) {
        events.shutdowns.push({ sampleTime: lastSampleTime, message: line });
      }
    }
  }

  // If there are any skipped stats left unprocessed at the end, process them now
  processSkippedStats();

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
  console.log(data);
  const plotData = {};
  const previousSampleTimes = {};
  const basetime = data.parsedData[0]['#sampletime'];
  const sampleResets = findPrintRestarts(data.parsedData);

  for (const d of data.parsedData) {
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
      const currentSampleTime = d['#sampletime'];
    
      // Initialize previous sample time for this MCU
      if (!previousSampleTimes[mcuPrefix]) { 
        previousSampleTimes[mcuPrefix] = d['#sampletime'];
      }

      // Time consistency check (per MCU)
      let timeDelta = 0;
    
      if (previousSampleTimes[mcuPrefix]) {
        timeDelta = currentSampleTime - previousSampleTimes[mcuPrefix];
      }

      // Update previous sample time before time jump adjustment
      previousSampleTimes[mcuPrefix] = currentSampleTime;

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
      xaxis: { title: 'Time' },
      yaxis: { title: 'Usage (%)' },
      font: { size: 12 },
      legend: { orientation: 'h', y: -0.15 },
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
    // times.push(st);
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
    xaxis: { title: 'Time' },
    yaxis: { title: 'Load (% of a core)' },
    yaxis2: { title: 'Available memory (KB)', overlaying: 'y', side: 'right', position: 0.97, showgrid: false },
    font: { size: 12 },
    legend: { orientation: 'h', y: -0.15 },
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
    xaxis: { title: 'Time' },
    yaxis: { title: 'Microsecond Deviation' },
    font: { size: 12 },
    legend: { orientation: 'h', y: -0.15 },
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
          break; case 'shutdowns':
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
      title: `Temperatures - ${heaterInfo.heater}`,
      xaxis: { title: 'Time' },
      yaxis: { title: 'Temperature' },
      yaxis2: {
        title: 'PWM',
        overlaying: 'y',
        side: 'right'
      },
      font: { size: 12 },
      legend: { orientation: 'h', y: -0.15 },
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
        }
    
        layout.annotations.push({
          x: evt.time,
          y: 0, // Anchor the annotation to the x-axis (y = 0)
          yref: 'paper', 
          ayref: 'paper',
          ax: 1, 
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

function plotAdvancedData(data) {
  // console.log(data);
  const plotData = {};

  for (const d of data.parsedData) {
    const mcuPrefixes = Object.keys(d.MCUs);

    for (const mcuPrefix of mcuPrefixes) {
      if (!plotData[mcuPrefix]) {
        plotData[mcuPrefix] = {
          times: [],
          srtt: [],
          rttvar: [],
          rto: [],
          ready_bytes: [],
          upcoming_bytes: []
        };
      }

      const currentSampleTime = d['#sampletime'];

      plotData[mcuPrefix].times.push(new Date(currentSampleTime * 1000));
      plotData[mcuPrefix].srtt.push(parseFloat(d.MCUs[mcuPrefix].srtt));
      plotData[mcuPrefix].rttvar.push(parseFloat(d.MCUs[mcuPrefix].rttvar));
      plotData[mcuPrefix].rto.push(parseFloat(d.MCUs[mcuPrefix].rto));
      plotData[mcuPrefix].ready_bytes.push(parseFloat(d.MCUs[mcuPrefix].ready_bytes));
      plotData[mcuPrefix].upcoming_bytes.push(parseFloat(d.MCUs[mcuPrefix].upcoming_bytes));
    }
  }

  // Parent container for all advanced graphs
  const plotDiv5 = document.getElementById('plotDiv5');

  plotDiv5.innerHTML = ''; // Clear any existing content

  // Convert event keys to Date objects
  const eventTimes = Object.keys(data.events).map((eventType) => ({
    eventType,
    events: data.events[eventType].map((event) => ({
      time: new Date(parseFloat(event.sampleTime) * 1000),
      message: event.message
    }))
  }));

  const metrics = ['srtt', 'rttvar', 'rto', 'ready_bytes', 'upcoming_bytes'];

  // Create graphs for all advanced metrics
  for (const mcuPrefix in plotData) {
    metrics.forEach((metric) => {
      const traces = [
        {
          x: plotData[mcuPrefix].times,
          y: plotData[mcuPrefix][metric],
          name: `${metric} - ${mcuPrefix}`,
          type: 'scatter',
          mode: 'lines',
          line: { color: 'blue' }
        }
      ];

      const plotDiv = document.createElement('div');

      plotDiv.id = `plotDiv_${mcuPrefix}_${metric}`;
      plotDiv5.appendChild(plotDiv);

      const layout = {
        title: `MCU ${metric} - ${mcuPrefix}`,
        xaxis: { title: 'Time' },
        yaxis: { title: `${metric}` },
        font: { size: 12 },
        legend: { orientation: 'h', y: -0.15 },
        grid: { columns: 1, pattern: 'independent', rows: 1 },
        annotations: [],
        shapes: []
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
          }

          layout.annotations.push({
            x: evt.time,
            y: 0,
            yref: 'paper',
            ayref: 'paper',
            ax: 0,
            ay: 1,
            arrowside: 'start',
            arrowcolor,
            hovertext: evt.message,
            showarrow: true,
            bgcolor: 'rgba(0, 0, 0, 0)'
          });
        });
      });

      Plotly.newPlot(plotDiv, traces, layout, { responsive: true });
    });
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
        plotAdvancedData(parsedData);
      };

      reader.readAsText(file);
    } else {
      alert('Please select a log file');
    }
  });
});
