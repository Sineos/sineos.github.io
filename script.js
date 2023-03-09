/* eslint-disable strict */
'use strict';

let divs, plots, myDiv1, myDiv2, myDiv3, myDiv4;
let selectedHeaters;

$(document).ready(function() {
  $('#fieldSelectHeater').change(function() {
    if ($(this).val() === 'custom') {
      $('#containerCustomHeater').show();
    } else {
      $('#containerCustomHeater').hide();
    }
  });

  $('#buttonProcess').click(function() {
    const file = $('#fileInput')[0].files[0];
    const reader = new FileReader();
    reader.readAsText(file);
    reader.onload = function() {
      selectedHeaters = $('#fieldSelectHeater').val();
      console.log(selectedHeaters);
      if (selectedHeaters !== 'custom') {
        selectedHeaters = $('#fieldSelectHeater').val();
      } else if (selectedHeaters === 'custom') {
        selectedHeaters = $('#inputCustomHeater').val();
        console.log(selectedHeaters);
      } else {
        alert('No heater(s) selected');
      }
      const contents = reader.result;
      processLog(contents);
      // Add event listener for zoom events
	  /* Does not work reliably  ¯\_(ツ)_/¯
      plots.forEach((div) => {
        div.on('plotly_relayout', function(ed) {
          relayout(ed, divs);
        });
      });
	  */
    };

  });

});

// https://stackoverflow.com/a/59430723
function relayout(ed, divs) {
  if (Object.entries(ed).length === 0) {
    return;
  }
  divs.forEach((div, i) => {
    const x = div.layout.xaxis;
    if (ed['xaxis.autorange'] && x.autorange) return;
    if (x.range[0] != ed['xaxis.range[0]'] || x.range[1] != ed['xaxis.range[1]']) {
      const update = {
        'xaxis.range[0]': ed['xaxis.range[0]'],
        'xaxis.range[1]': ed['xaxis.range[1]'],
        'xaxis.autorange': ed['xaxis.autorange'],
        'yaxis.autorange': ed['yaxis.autorange'],
        'yaxis2.autorange': ed['yaxis2.autorange']
      };
      Plotly.relayout(div, update);
    }
  });
}

function processLog(content) {
  const processed = parseLog(content);
  plotMCU(processed, 2500.0);
  plotSystem(processed);
  plotMCUfrequencies(processed);
  plotTemperature(processed, selectedHeaters);
  myDiv1 = document.getElementById('plotDiv');
  myDiv2 = document.getElementById('plotDiv2');
  myDiv3 = document.getElementById('plotDiv3');
  myDiv4 = document.getElementById('plotDiv4');
  divs = [myDiv1, myDiv2, myDiv3, myDiv4];
  plots = [myDiv1, myDiv2, myDiv3, myDiv4];
}

function parseLog(logname, mcu) {
  const listPrefix = ['mcu_awake', 'mcu_task_avg', 'mcu_task_stddev', 'bytes_write', 'bytes_read', 'bytes_retransmit', 'freq', 'adj', 'target', 'temp', 'pwm'];
  if (!mcu) {
    mcu = 'mcu';
  }
  const MCUprefix = mcu + ':';
  const applyPrefix = {};
  for (let i = 0; i < listPrefix.length; i++) {
    applyPrefix[listPrefix[i]] = 1;
  }
  const out = [];
  const lines = logname.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.split(' ');
    let prefix = '';
    const keyparts = {};
    for (let j = 2; j < parts.length; j++) {
      const p = parts[j];
      if (p.indexOf('=') === -1) {
        prefix = p;
        if (prefix === MCUprefix) {
          prefix = '';
        }
        continue;
      }
      let [name, val] = p.split('=');
      if (applyPrefix[name]) {
        name = prefix + name;
      }
      keyparts[name] = val;
    }
    if (!keyparts['print_time']) {
      continue;
    }
    keyparts['#sampletime'] = parseFloat(parts[1].slice(0, -1));
    out.push(keyparts);
  }
  return out;
}

function findPrintRestarts(data) {
  const runoffSamples = {};
  let lastRunoffStart = 0;
  let lastBufferTime = 0;
  let lastSampleTime = 0;
  let lastPrintStall = 0;
  for (let i = data.length - 1; i >= 0; i--) {
    const d = data[i];
    const sampleTime = d['#sampletime'];
    const bufferTime = parseFloat(d['buffer_time'] || 0);
    if (lastRunoffStart && lastSampleTime - sampleTime < 5 && bufferTime > lastBufferTime) {
      runoffSamples[lastRunoffStart][1].push(sampleTime);
    } else if (bufferTime < 1) {
      lastRunoffStart = sampleTime;
      runoffSamples[lastRunoffStart] = [false, [sampleTime]];
    } else {
      lastRunoffStart = 0;
    }
    lastBufferTime = bufferTime;
    lastSampleTime = sampleTime;
    const printStall = parseInt(d['print_stall'], 10);
    if (printStall < lastPrintStall) {
      if (lastRunoffStart) {
        runoffSamples[lastRunoffStart][0] = true;
      }
    }
    lastPrintStall = printStall;
  }
  const sampleResets = {};
  for (const [stall, samples] of Object.values(runoffSamples)) {
    for (const sampleTime of samples) {
      if (!stall) {
        sampleResets[sampleTime] = 1;
      }
    }
  }
  return sampleResets;
}

function plotMCU(data, maxbw) {
  const TASK_MAX = 0.0025;
  const MAXBUFFER = 2;
  const STATS_INTERVAL = 5;
  // Generate data for plot
  let lasttime;
  const basetime = lasttime = data[0]['#sampletime'];
  let lastbw = parseFloat(data[0]['bytes_write']) + parseFloat(data[0]['bytes_retransmit']);
  const sampleResets = findPrintRestarts(data);
  const times = [];
  const bwDeltas = [];
  const loads = [];
  const awake = [];
  const hostBuffers = [];
  for (const d of data) {
    const st = d['#sampletime'];
    const timedelta = st - lasttime;
    //if (timedelta <= 0) {
    //  continue;
    //}
    const bw = parseFloat(d['bytes_write']) + parseFloat(d['bytes_retransmit']);
    if (bw < lastbw) {
      lastbw = bw;
      //continue;
    }
    let load = parseFloat(d['mcu_task_avg']) + (3 * parseFloat(d['mcu_task_stddev']));
    if (st - basetime < 15) {
      load = 0;
    }
    const pt = parseFloat(d['print_time']);
    let hb = parseFloat(d['buffer_time']);
    if (hb >= MAXBUFFER || sampleResets[st]) {
      hb = 0;
    } else {
      hb = 100 * (MAXBUFFER - hb) / MAXBUFFER;
    }
    hostBuffers.push(hb);
    times.push(new Date(st * 1000));
    bwDeltas.push(100 * (bw - lastbw) / (maxbw * timedelta));
    loads.push(100 * load / TASK_MAX);
    awake.push(100 * parseFloat(d['mcu_awake'] || 0) / STATS_INTERVAL);
    lasttime = st;
    lastbw = bw;
  }
  // Build plot
  const trace1 = {
    x: times,
    y: bwDeltas,
    mode: 'lines',
    line: {
      color: 'green'
    },
    name: 'Bandwidth'
  };
  const trace2 = {
    x: times,
    y: loads,
    mode: 'lines',
    line: {
      color: 'red'
    },
    name: 'MCU Load'
  };
  const trace3 = {
    x: times,
    y: hostBuffers,
    mode: 'lines',
    line: {
      color: 'cyan'
    },
    name: 'Host Buffer'
  };
  const trace4 = {
    x: times,
    y: awake,
    mode: 'lines',
    line: {
      color: 'yellow'
    },
    name: 'Awake Time'
  };
  const layout = {
    title: 'MCU bandwidth and load utilization',
    xaxis: {
      title: 'Time',
      tickformat: '%H:%M'
    },
    yaxis: {
      title: 'Usage (%)'
    },
    font: {
      size: 12
    },
    legend: {
      orientation: 'h'
    },
    grid: {
      rows: 1,
      columns: 1,
      pattern: 'independent'
    }
  };
  const dataPlot = [trace1, trace2, trace3, trace4];
  Plotly.newPlot('plotDiv', dataPlot, layout, {
    responsive: true
  });
}

function plotSystem(data) {
  // Generate data for plot
  let lasttime = data[0]['#sampletime'];
  let lastcputime = parseFloat(data[0]['cputime']);
  const times = [];
  const sysloads = [];
  const cputimes = [];
  const memavails = [];
  for (const d of data) {
    const st = d['#sampletime'];
    const timedelta = st - lasttime;
    //if (timedelta <= 0.0) {
    //  continue;
    //}
    lasttime = st;
    times.push(new Date(st * 1000)); // convert to milliseconds
    const cputime = parseFloat(d['cputime']);
    const cpudelta = Math.max(0.0, Math.min(1.5, (cputime - lastcputime) / timedelta));
    lastcputime = cputime;
    cputimes.push(cpudelta * 100.0);
    sysloads.push(parseFloat(d['sysload']) * 100.0);
    memavails.push(parseFloat(d['memavail']));
  }
  // Build plot
  const trace1 = {
    x: times,
    y: sysloads,
    name: 'System Load',
    type: 'scatter',
    mode: 'lines',
    line: {
      color: 'cyan',
      width: 1,
      opacity: 1.0
    }
  };
  const trace2 = {
    x: times,
    y: cputimes,
    name: 'Process Time',
    type: 'scatter',
    mode: 'lines',
    line: {
      color: 'red',
      width: 1,
      opacity: 0.1
    },
    yaxis: 'y'
  };
  const trace3 = {
    x: times,
    y: memavails,
    name: 'System Memory',
    type: 'scatter',
    mode: 'lines',
    line: {
      color: 'yellow',
      width: 1,
      opacity: 0.3
    },
    yaxis: 'y2'
  };
  const layout = {
    title: 'System load utilization',
    xaxis: {
      title: 'Time',
      tickformat: '%H:%M'
    },
    yaxis: {
      title: 'Load (% of a core)'
    },
    yaxis2: {
      title: 'Available memory (KB)',
      overlaying: 'y',
      side: 'right',
      position: 0.97,
      showgrid: false
    },
    font: {
      size: 12
    },
    legend: {
      orientation: 'h'
    },
    grid: {
      rows: 1,
      columns: 1,
      pattern: 'independent'
    }
  };
  const dataPlot = [trace1, trace2, trace3];
  Plotly.newPlot('plotDiv2', dataPlot, layout, {
    responsive: true
  });
}

function plotMCUfrequencies(data) {
  // Collect all keys from data
  const allKeys = data.reduce((acc, d) => {
    Object.keys(d).forEach((key) => {
      acc[key] = true;
    });
    return acc;
  }, {});
  // Filter out non-frequency keys
  const graphKeys = {};
  Object.keys(allKeys).forEach((key) => {
    if (key === 'freq' || key === 'adj' || key.endsWith(':freq') || key.endsWith(':adj')) {
      graphKeys[key] = [
        [],
        []
      ];
    }
  });
  // Collect data for each graph key
  data.forEach((d) => {
    const st = new Date(d['#sampletime'] * 1000);
    Object.entries(graphKeys).forEach(([key, [times, values]]) => {
      const val = d[key];
      if (val !== undefined && val !== '0' && val !== '1') {
        times.push(st);
        values.push(parseFloat(val));
      }
    });
  });
  // Calculate estimated MHz for each graph key
  const estMhz = {};
  Object.entries(graphKeys).forEach(([key, [times, values]]) => {
    const mhz = Math.round(values.reduce((acc, val) => acc + val, 0) / values.length / 1000000);
    estMhz[key] = mhz;
  });
  // Build plot data
  const plotData = [];
  Object.keys(graphKeys).sort().
    forEach((key) => {
      const [times, values] = graphKeys[key];
      const mhz = estMhz[key];
      const label = `${key}(${mhz}Mhz)`;
      const hz = mhz * 1000000;
      plotData.push({
        x: times,
        y: values.map((v) => (v - hz) / mhz),
        type: 'scatter',
        mode: 'markers',
        name: label
      });
    });
  // Build plot layout
  const layout = {
    title: 'MCU frequencies',
    xaxis: {
      title: 'Time',
      tickformat: '%H:%M'
    },
    yaxis: {
      title: 'Microsecond deviation'
    },
    font: {
      size: 12
    },
    legend: {
      orientation: 'h'
    },
    grid: {
      rows: 1,
      columns: 1,
      pattern: 'independent'
    }
  };
  // Create plot
  return Plotly.newPlot('plotDiv3', plotData, layout);
}

function plotTemperature(data, heaters) {
  const traces = [];
  for (let heater of heaters.split(',')) {
    heater = heater.trim();
    const tempKey = `${heater}:temp`;
    const targetKey = `${heater}:target`;
    const PWMkey = `${heater}:pwm`;
    const times = [];
    const temps = [];
    const targets = [];
    const pwm = [];
    for (const d of data) {
      const temp = d[tempKey];
      //if (temp === undefined) {
      //  continue;
      //}
      times.push(new Date(d['#sampletime'] * 1000));
      temps.push(parseFloat(temp));
      pwm.push(parseFloat(d[PWMkey] || 0));
      targets.push(parseFloat(d[targetKey] || 0));
    }
    traces.push({
      x: times,
      y: temps,
      type: 'scatter',
      mode: 'lines',
      name: `${heater} temp`,
      line: {
        width: 2
      }
    });
    if (targets.some(Boolean)) {
      traces.push({
        x: times,
        y: targets,
        type: 'scatter',
        mode: 'lines',
        name: `${heater} target`,
        line: {
          width: 1,
          dash: 'dot'
        }
      });
    }
    if (pwm.some(Boolean)) {
      traces.push({
        x: times,
        y: pwm,
        type: 'scatter',
        mode: 'lines',
        yaxis: 'y2',
        name: `${heater} PWM`,
        line: {
          width: 1,
          opacity: 0.5,
          dash: 'dash'
        }
      });
    }
  }
  const layout = {
    title: `Temperature of ${heaters}`,
    xaxis: {
      title: 'Time',
      tickformat: '%H:%M'
    },
    yaxis: {
      title: 'Temperature',
      side: 'left'
    },
    yaxis2: {
      title: 'PWM',
      side: 'right',
      overlaying: 'y'
    },
    font: {
      size: 12
    },
    legend: {
      orientation: 'h'
    },
    grid: {
      rows: 1,
      columns: 1,
      pattern: 'independent'
    }
  };
  Plotly.newPlot('plotDiv4', traces, layout, {
    responsive: true
  });
}
