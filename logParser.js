// ======================================================================
//  LOGIC: Klipper Log Parsing
// ======================================================================

const LOGIC_CONSTANTS = {
    KEYS_TO_PREFIX: new Set([
      'mcu_awake', 'mcu_task_avg', 'mcu_task_stddev', 'bytes_write',
      'bytes_read', 'bytes_retransmit', 'bytes_invalid', 'send_seq', 'receive_seq',
      'retransmit_seq', 'srtt', 'rttvar', 'rto', 'ready_bytes', 'upcoming_bytes',
      'freq', 'adj', 'target', 'temp', 'pwm', 'coil_temp', 'bus_state', 'rx_error', 'tx_error', 'tx_retries'
    ]),
    MAXBANDWIDTH: 25000.0,
    MAXBUFFER: 2.0,
    STATS_INTERVAL: 5.0,
    TASK_MAX: 0.0025
};

function findPrintResets(data) {
    let runoff_samples = {};
    let last_runoff_start = 0, last_buffer_time = 0, last_sampletime = 0;
    let last_print_stall = 0;

    for (let i = data.length - 1; i >= 0; i--) {
        const d = data[i];
        const sampletime = d['#sampletime'].getTime() / 1000;
        const buffer_time = d.buffer_time || 0;

        if (last_runoff_start && (last_sampletime - sampletime < 5) && buffer_time > last_buffer_time) {
            runoff_samples[last_runoff_start][1].push(sampletime);
        } else if (buffer_time < 1.0) {
            last_runoff_start = sampletime;
            runoff_samples[last_runoff_start] = [false, [sampletime]];
        } else {
            last_runoff_start = 0;
        }
        last_buffer_time = buffer_time;
        last_sampletime = sampletime;

        const print_stall = d.print_stall || 0;
        if (print_stall < last_print_stall) {
            if (last_runoff_start && runoff_samples[last_runoff_start]) {
                runoff_samples[last_runoff_start][0] = true;
            }
        }
        last_print_stall = print_stall;
    }

    const sample_resets = new Set();
    Object.values(runoff_samples).forEach(value => {
        const stall = value[0];
        const samples = value[1];
        if (!stall) {
            samples.forEach(sampletime => sample_resets.add(sampletime * 1000));
        }
    });
    return sample_resets;
}

function parseKlipperLog(logContent) {
    const lines = logContent.split('\n');
    const result = {
        sessions: [],
        metrics: {},
        events: [],
        devices: { mcu: new Set(), heaters: new Set(), temp_sensors: new Set(), can: new Set() },
    };

    const discoveredEvents = [];
    lines.forEach((line, index) => {
        const startMatch = line.match(/Start printer at (.*?) \((\d+\.?\d*)\s+(\d+\.?\d*)\)/);
        if (startMatch) {
            const dateStr = startMatch[1].replace(/ /g, ' ');
            const unixTs = parseFloat(startMatch[2]);
            const uptime = parseFloat(startMatch[3]);
            discoveredEvents.push({ type: 'start', lineIndex: index, baseTimestamp: unixTs - uptime, eventTime: new Date(unixTs * 1000), eventText: `Printer Start<br>${dateStr}` });
            return;
        }

        const rolloverMatch = line.match(/=============== Log rollover at (.*) ===============/);
        if (rolloverMatch) {
            const dateStr = rolloverMatch[1].replace(/ /g, ' ').replace('  ', ' ');
            const rolloverTs = Date.parse(dateStr + " GMT");
            if (!isNaN(rolloverTs)) {
                const nextStatsMatch = logContent.substring(logContent.indexOf(line)).match(/^Stats (\d+\.?\d*):/m);
                if (nextStatsMatch) {
                    const nextUptime = parseFloat(nextStatsMatch[1]);
                    discoveredEvents.push({ type: 'start', lineIndex: index, baseTimestamp: (rolloverTs / 1000) - nextUptime, eventTime: new Date(rolloverTs), eventText: `Log Rollover<br>${dateStr}` });
                }
            }
            return;
        }

        const shutdownMatch = line.match(/Transition to shutdown state: (.*)/);
        if (shutdownMatch) {
            discoveredEvents.push({ type: 'shutdown', lineIndex: index, reason: shutdownMatch[1].trim() });
            return;
        }

        const legacyShutdownMatch = line.match(/Once the underlying issue is corrected, use the/);
        if (legacyShutdownMatch && index > 0) {
            const reason = lines[index - 1].trim();
            if(reason && !reason.includes("FIRMWARE_RESTART")) {
                discoveredEvents.push({ type: 'shutdown', lineIndex: index, reason });
            }
        }
    });

    const startEvents = discoveredEvents.filter(e => e.type === 'start');
    const shutdownEvents = discoveredEvents.filter(e => e.type === 'shutdown');

    if (startEvents.length === 0) throw new Error("No valid session start ('Start printer' or 'Log rollover') found in the log file.");

    startEvents.forEach((startEvent, i) => {
        const nextStartEvent = (i + 1 < startEvents.length) ? startEvents[i + 1] : null;
        const firstShutdown = shutdownEvents.find(se => se.lineIndex > startEvent.lineIndex && (!nextStartEvent || se.lineIndex < nextStartEvent.lineIndex));
        const sessionEndLine = Math.min(nextStartEvent ? nextStartEvent.lineIndex : lines.length, firstShutdown ? firstShutdown.lineIndex : lines.length);

        const session = {
            id: i,
            type: 'explicit',
            startLine: startEvent.lineIndex,
            endLine: sessionEndLine,
            baseTimestamp: startEvent.baseTimestamp,
            startTime: startEvent.eventTime,
            rawMetrics: [],
            events: [{ time: startEvent.eventTime, text: startEvent.eventText }],
            devices: { mcu: new Set(), heaters: new Set(), temp_sensors: new Set(), can: new Set() }
        };

        let lastAbsoluteTime = null;
        for (let j = session.startLine; j < session.endLine; j++) {
            const line = lines[j];
            const statsMatch = line.match(/^Stats (\d+\.?\d*):(.*)/);
            if (statsMatch) {
                const uptime = parseFloat(statsMatch[1]);
                const absoluteTime = new Date((session.baseTimestamp + uptime) * 1000);
                lastAbsoluteTime = absoluteTime;

                const currentSample = { '#sampletime': absoluteTime, session_id: session.id };
                const content = statsMatch[2].trim();
                const parts = content.split(/\s+/);
                let prefix = '';
                parts.forEach(p => {
                    if (!p.includes('=')) {
                        prefix = p; return;
                    }
                    const [key, valueStr] = p.split('=', 2);
                    const deviceName = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
                    let metricName = key;
                    if (prefix && LOGIC_CONSTANTS.KEYS_TO_PREFIX.has(key)) metricName = `${deviceName}:${key}`;
                    if (key === 'temp' || key === 'target') {
                        if (valueStr.includes('/')) return;
                        if (prefix.includes('heater') || prefix.includes('extruder')) session.devices.heaters.add(deviceName);
                        else session.devices.temp_sensors.add(deviceName);
                    }
                    if (key === 'mcu_awake') session.devices.mcu.add(deviceName);
                    if (prefix.startsWith('canstat')) session.devices.can.add(deviceName);
                    currentSample[metricName] = parseFloat(valueStr);
                });
                if (currentSample.sysload !== undefined) session.rawMetrics.push(currentSample);
            }
        }

        if (firstShutdown) {
            session.shutdownReason = firstShutdown.reason;
            session.endTime = lastAbsoluteTime || session.startTime;
            session.events.push({ time: session.endTime, text: `Shutdown:<br>${firstShutdown.reason}` });
        } else {
            session.endTime = lastAbsoluteTime || (nextStartEvent ? nextStartEvent.eventTime : null);
        }

        result.sessions.push(session);

        if (firstShutdown) {
            const implicitSearchStart = firstShutdown.lineIndex;
            const implicitSearchEnd = nextStartEvent ? nextStartEvent.lineIndex : lines.length;
            let firstImplicitStats = null, firstImplicitStatsLine = -1;

            for(let j = implicitSearchStart; j < implicitSearchEnd; j++) {
                if(lines[j].startsWith("Stats")) {
                    firstImplicitStats = lines[j].match(/^Stats (\d+\.?\d*):(.*)/);
                    firstImplicitStatsLine = j;
                    break;
                }
            }

            if(firstImplicitStats && session.endTime) {
                const implicitUptime = parseFloat(firstImplicitStats[1]);
                const implicitBaseTimestamp = (session.endTime.getTime() / 1000) - implicitUptime;
                const implicitSession = {
                    id: i + 0.5, type: 'implicit', startLine: firstImplicitStatsLine, endLine: implicitSearchEnd,
                    baseTimestamp: implicitBaseTimestamp, startTime: session.endTime, endTime: null, rawMetrics: [],
                    events: [{ time: session.endTime, text: `Implicit Session Start<br>(Post-Shutdown)` }],
                    devices: { mcu: new Set(), heaters: new Set(), temp_sensors: new Set(), can: new Set() }
                };

                let lastImplicitTime = null;
                for (let j = implicitSession.startLine; j < implicitSession.endLine; j++) {
                    const line = lines[j];
                    const statsMatch = line.match(/^Stats (\d+\.?\d*):(.*)/);
                    if (statsMatch) {
                        const uptime = parseFloat(statsMatch[1]);
                        const absoluteTime = new Date((implicitSession.baseTimestamp + uptime) * 1000);
                        lastImplicitTime = absoluteTime;
                        const currentSample = { '#sampletime': absoluteTime, session_id: implicitSession.id };
                        const content = statsMatch[2].trim();
                        const parts = content.split(/\s+/);
                        let prefix = '';
                        parts.forEach(p => {
                            if (!p.includes('=')) { prefix = p; return; }
                            const [key, valueStr] = p.split('=', 2);
                            const deviceName = prefix.endsWith(':') ? prefix.slice(0, -1) : prefix;
                            let metricName = key;
                            if (prefix && LOGIC_CONSTANTS.KEYS_TO_PREFIX.has(key)) metricName = `${deviceName}:${key}`;
                            if (key === 'temp' || key === 'target') {
                                if (valueStr.includes('/')) return;
                                if (prefix.includes('heater') || prefix.includes('extruder')) implicitSession.devices.heaters.add(deviceName);
                                else implicitSession.devices.temp_sensors.add(deviceName);
                            }
                            if (key === 'mcu_awake') implicitSession.devices.mcu.add(deviceName);
                            if (prefix.startsWith('canstat')) implicitSession.devices.can.add(deviceName);
                            currentSample[metricName] = parseFloat(valueStr);
                        });
                        if (currentSample.sysload !== undefined) implicitSession.rawMetrics.push(currentSample);
                    }
                }
                implicitSession.endTime = lastImplicitTime || implicitSession.startTime;
                result.sessions.push(implicitSession);
            }
        }
    });

    const allRawMetrics = result.sessions.flatMap(s => s.rawMetrics);

    if (allRawMetrics.length === 0) {
        if (result.sessions.length > 0) {
            result.events = result.sessions.flatMap(s => s.events).sort((a,b) => a.time - b.time);
            result.sessions.forEach(session => {
                if (session.type === 'implicit') session.name = `Session ${session.id} (Implicit)`;
                else {
                    let name = `Session ${session.id} (Explicit)`;
                    if (session.shutdownReason) name += ` - Shutdown: ${session.shutdownReason.substring(0, 25)}...`;
                    session.name = name;
                }
            });
            for (const key in result.devices) { result.devices[key] = Array.from(result.devices[key]); }
            return result;
        }
        throw new Error("No valid 'Stats' lines found in the log file.");
    }

    allRawMetrics.sort((a, b) => a['#sampletime'] - b['#sampletime']);

    const sampleResets = findPrintResets(allRawMetrics);
    let lastValues = {};

    allRawMetrics.forEach(d => {
        const time = d['#sampletime'];
        for(const key in d) {
            if (!result.metrics[key]) result.metrics[key] = { x: [], y: [] };
            result.metrics[key].x.push(time);
            result.metrics[key].y.push(d[key]);
        }
        const cputime = d.cputime;
        const lastCpu = lastValues['host_cpu'] || {time: 0, val: 0};
        const timedelta = (time.getTime() - lastCpu.time) / 1000;
        if (cputime !== undefined && timedelta > 0) {
            const cpudelta = Math.max(0, Math.min(1.5, (cputime - lastCpu.val) / timedelta));
            const key = 'host:process_time';
            if (!result.metrics[key]) result.metrics[key] = { x: [], y: [] };
            result.metrics[key].x.push(time);
            result.metrics[key].y.push(cpudelta * 100);
        }
        if(cputime !== undefined) lastValues['host_cpu'] = {time: time.getTime(), val: cputime};

        const bufferTime = d.buffer_time;
        let hostBufferValue = 0;
        if (bufferTime !== undefined) {
            hostBufferValue = (bufferTime >= LOGIC_CONSTANTS.MAXBUFFER || sampleResets.has(time.getTime()))
                ? 0
                : 100 * (LOGIC_CONSTANTS.MAXBUFFER - bufferTime) / LOGIC_CONSTANTS.MAXBUFFER;
        }
        const hbKey = 'host:buffer';
        if (!result.metrics[hbKey]) result.metrics[hbKey] = { x: [], y: [] };
        result.metrics[hbKey].x.push(time);
        result.metrics[hbKey].y.push(hostBufferValue);

        result.devices.mcu.forEach(mcu => {
            const prefix = `${mcu}:`;
            const lastMcu = lastValues[mcu] || {time: 0, bw: 0};
            const mcuTimedelta = (time.getTime() - lastMcu.time) / 1000;
            if (mcuTimedelta > 0) {
                const bw = (d[prefix + 'bytes_write'] || 0) + (d[prefix+'bytes_retransmit'] || 0);
                if (bw >= lastMcu.bw) {
                    const bwKey = prefix + 'bandwidth';
                    const bwDelta = 100 * (bw - lastMcu.bw) / (LOGIC_CONSTANTS.MAXBANDWIDTH * mcuTimedelta);
                    if (!result.metrics[bwKey]) result.metrics[bwKey] = { x: [], y: [] };
                    result.metrics[bwKey].x.push(time);
                    result.metrics[bwKey].y.push(bwDelta);
                }
                lastValues[mcu] = { ...lastMcu, bw: bw };

                const load = (d[prefix+'mcu_task_avg'] || 0) + 3 * (d[prefix+'mcu_task_stddev'] || 0);
                const loadKey = prefix + 'load';
                const loadPerc = 100 * load / LOGIC_CONSTANTS.TASK_MAX;
                if (!result.metrics[loadKey]) result.metrics[loadKey] = { x: [], y: [] };
                result.metrics[loadKey].x.push(time);
                result.metrics[loadKey].y.push(loadPerc);
            }
            if(mcuTimedelta > 0) lastValues[mcu] = { ...lastValues[mcu], time: time.getTime() };
        });
    });

    const freqKeys = Object.keys(result.metrics).filter(k => (k.endsWith(':freq') || k.endsWith(':adj')) && !k.startsWith('host:'));
    freqKeys.forEach(key => {
        const values = result.metrics[key].y;
        if (!values || values.length === 0) return;
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        if (avg === 0) return;
        const mhz = Math.round(avg / 1000000);
        const hz = mhz * 1000000;
        const devKey = `${key}_deviation`;
        result.metrics[devKey] = {
            x: result.metrics[key].x,
            y: values.map(v => (v - hz) / mhz),
            label: `${key} (${mhz}Mhz)`
        };
    });

    result.sessions.forEach(session => {
        session.dataPointCount = session.rawMetrics.length;

        let name;
        if (session.type === 'implicit') {
            name = `Session ${session.id} (Implicit)`;
        } else {
            name = `Session ${session.id} (Explicit)`;
            if (session.shutdownReason) {
                name += ` - Shutdown: ${session.shutdownReason.substring(0, 20)}...`;
            }
        }
        name += ` (${session.dataPointCount} data points)`;
        session.name = name;

        for (const key in session.devices) {
            session.devices[key] = Array.from(session.devices[key]);
        }
    });

    result.events = result.sessions.flatMap(s => s.events).sort((a, b) => a.time - b.time);
    for (const session of result.sessions) {
        for (const deviceType in session.devices) {
            for (const deviceName of session.devices[deviceType]) {
                result.devices[deviceType].add(deviceName);
            }
        }
    }
    for (const key in result.devices) {
        result.devices[key] = Array.from(result.devices[key]);
    }

    return result;
}