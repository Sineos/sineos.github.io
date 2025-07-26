// ======================================================================
//  UI & APP LOGIC: React Application
// ======================================================================

const { useState, useEffect, useRef, useMemo, useCallback } = React;

/**
 * Creates a self-contained Web Worker that parses the log, serves
 * line chunks, and filters data on demand.
 */
function createWorkerBlobURL() {
    const workerLogicString = `
        // Store full log data in the worker's scope
        let logLines = [];
        let fullMetrics = {};
        let allEvents = [];
        let allDevices = {};
        let allSessions = [];

        // Bring in parsing logic
        const LOGIC_CONSTANTS = {
            KEYS_TO_PREFIX: new Set(${JSON.stringify(Array.from(LOGIC_CONSTANTS.KEYS_TO_PREFIX))}),
            MAXBANDWIDTH: ${LOGIC_CONSTANTS.MAXBANDWIDTH},
            MAXBUFFER: ${LOGIC_CONSTANTS.MAXBUFFER},
            STATS_INTERVAL: ${LOGIC_CONSTANTS.STATS_INTERVAL},
            TASK_MAX: ${LOGIC_CONSTANTS.TASK_MAX}
        };
        const findPrintResets = ${findPrintResets.toString()};
        const parseKlipperLog = ${parseKlipperLog.toString()};

        // Handle messages from the main thread
        self.onmessage = (event) => {
            const { type, data } = event.data;

            switch (type) {
                case 'parse':
                    try {
                        const { logContent } = data;
                        const processedData = parseKlipperLog(logContent);
                        
                        // Store all data within the worker
                        logLines = processedData.logLines;
                        fullMetrics = processedData.metrics;
                        allEvents = processedData.events;
                        allDevices = processedData.devices;
                        allSessions = processedData.sessions;

                        // Send initial data (all sessions) and metadata to main thread
                        self.postMessage({ 
                            status: 'success', 
                            type: 'parseResult', 
                            data: {
                                metrics: fullMetrics,
                                events: allEvents,
                                devices: allDevices,
                                sessions: allSessions
                            } 
                        });
                    } catch (error) {
                        self.postMessage({ status: 'error', message: error.message });
                    }
                    break;

                case 'filter_session':
                    try {
                        const { sessionId } = data;
                        if (sessionId === 'all') {
                            self.postMessage({
                                status: 'success',
                                type: 'filterResult',
                                data: { metrics: fullMetrics, events: allEvents, devices: allDevices }
                            });
                            return;
                        }

                        const session = allSessions.find(s => s.id == sessionId);
                        if (!session) throw new Error('Session not found');

                        const { startTime, endTime } = session;
                        const start = new Date(startTime).getTime();
                        const end = endTime ? new Date(endTime).getTime() : Number.MAX_SAFE_INTEGER;
                        const filteredMetrics = {};
                        
                        const metricKeys = Object.keys(fullMetrics);
                        for (let i = 0, len = metricKeys.length; i < len; i++) {
                            const key = metricKeys[i];
                            const metric = fullMetrics[key];
                            const newX = [], newY = [], newLines = [];
                            const metricX = metric.x;
                            const metricY = metric.y;
                            const metricLines = metric.lines;

                            for (let j = 0, dataLen = metricX.length; j < dataLen; j++) {
                                const time = new Date(metricX[j]).getTime();
                                if (time >= start && time <= end) {
                                    newX.push(metricX[j]);
                                    newY.push(metricY[j]);
                                    if (metricLines) newLines.push(metricLines[j]);
                                }
                            }
                            if (newX.length > 0) {
                                filteredMetrics[key] = { ...metric, x: newX, y: newY, lines: newLines };
                            }
                        }

                        self.postMessage({
                            status: 'success',
                            type: 'filterResult',
                            data: { metrics: filteredMetrics, events: session.events, devices: session.devices }
                        });

                    } catch (error) {
                         self.postMessage({ status: 'error', message: 'Failed to filter session.' });
                    }
                    break;

                case 'fetch_lines':
                    try {
                        const { line, context } = data;
                        const start = Math.max(0, line - context);
                        const end = Math.min(logLines.length, line + context + 1);
                        const slice = logLines.slice(start, end);
                        
                        self.postMessage({
                            status: 'success',
                            type: 'logChunk',
                            data: {
                                lines: slice,
                                highlight: line,
                                offset: start
                            }
                        });
                    } catch (error) {
                        self.postMessage({ status: 'error', message: 'Failed to fetch log lines.' });
                    }
                    break;
            }
        };
    `;
    const blob = new Blob([workerLogicString], { type: 'application/javascript' });
    return URL.createObjectURL(blob);
}

/**
 * Helper function to merge chart definitions
 */
function deepMerge(target, source) {
    const output = {...target};
    for (const key in source) {
        if (source.hasOwnProperty(key)) {
            if (isObject(target[key]) && isObject(source[key])) {
                output[key] = deepMerge(target[key], source[key]);
            } else {
                output[key] = source[key];
            }
        }
    }
    return output;
};
function isObject(item) { return item && typeof item === 'object' && !Array.isArray(item); };
function normalizeAxis(axis) {
    if (!axis) return null;
    if (typeof axis.title === 'string') axis.title = { text: axis.title };
    return axis;
};

/**
 * Plotly chart component.
 */
const PlotlyChart = React.memo(({ data, layout, title, theme, onRelayout, xAxisRange, onPointClick }) => {
    const chartRef = useRef(null);

    const finalLayout = useMemo(() => {
        const baseLayout = {
            title: { text: `<b>${title}</b>`, font: { color: 'var(--text-color)', size: 16 }, x: 0.05, xanchor: 'left' },
            paper_bgcolor: 'rgba(0,0,0,0)',
            plot_bgcolor: 'rgba(0,0,0,0)',
            font: { color: 'var(--text-color)', size: 12 },
            legend: { orientation: 'h', x: 0.01, y: -0.2, xanchor: 'left', yanchor: 'top', font: { size: 12 } },
            xaxis: { title: { text: 'Time', font: { size: 14 }, standoff: 15 }, gridcolor: 'var(--grid-color)', type: 'date', zerolinecolor: 'var(--zeroline-color)', gridwidth: 0.5, griddash: 'dot', tickfont: { size: 12 }, titlefont: { size: 14 } },
            yaxis: { title: { text: '', font: { size: 14 }, standoff: 10 }, gridcolor: 'var(--grid-color)', zerolinecolor: 'var(--zeroline-color)', gridwidth: 0.5, griddash: 'dot', tickfont: { size: 12 }, titlefont: { size: 14 }, tickformat: ',.2r', automargin: true },
            yaxis2: { title: { text: '', font: { size: 14 }, standoff: 10 }, overlaying: 'y', side: 'right', tickfont: { size: 12 }, titlefont: { size: 14 }, showgrid: false, tickmode: 'sync', tickformat: ',.2r', automargin: true },
            margin: { t: 60, b: 80, l: 70, r: 70 },
            hovermode: 'x unified',
            hoverlabel: { bgcolor: theme === 'dark' ? 'rgba(40, 40, 40, 0.95)' : 'rgba(255, 255, 255, 0.95)', bordercolor: 'var(--primary-color)', font: { color: theme === 'dark' ? '#ffffff' : '#212121', size: 12 } }
        };

        const normalizedLayout = {...layout};
        if (normalizedLayout.yaxis) normalizedLayout.yaxis = normalizeAxis(normalizedLayout.yaxis);
        if (normalizedLayout.yaxis2) normalizedLayout.yaxis2 = normalizeAxis(normalizedLayout.yaxis2);
        let fullLayout = deepMerge(baseLayout, normalizedLayout);
        if (normalizedLayout.yaxis?.title?.text) fullLayout.yaxis.title.text = normalizedLayout.yaxis.title.text;
        if (normalizedLayout.yaxis2?.title?.text) fullLayout.yaxis2.title.text = normalizedLayout.yaxis2.title.text;

        if (xAxisRange) {
            fullLayout.xaxis.range = xAxisRange;
            fullLayout.xaxis.autorange = false;
        } else {
            fullLayout.xaxis.autorange = true;
            delete fullLayout.xaxis.range;
            fullLayout.yaxis.autorange = true;
            if (fullLayout.yaxis2) fullLayout.yaxis2.autorange = true;
        }
        return fullLayout;
    }, [layout, title, theme, xAxisRange]);

    useEffect(() => {
        if (chartRef.current && data) {
            const plotDiv = chartRef.current;
            const plotConfig = { responsive: true, displayModeBar: true, displaylogo: false, doubleClick: 'reset+autosize', modeBarButtonsToRemove: ['lasso2d', 'select2d'] };
            
            // Draw a new plot, which purges the old one
            Plotly.newPlot(plotDiv, data, finalLayout, plotConfig);

            // Define handlers
            const handleRelayout = (eventData) => {
                if (onRelayout && Object.keys(eventData).length > 0 && !eventData['dragmode']) {
                     onRelayout(eventData);
                }
            };
            const handleClick = (eventData) => {
                if (onPointClick && eventData.event.button === 1 && eventData.points.length > 0) {
                    const point = eventData.points[0];
                    if (point.customdata !== undefined) {
                        eventData.event.preventDefault();
                        onPointClick(point.customdata);
                    }
                }
            };

            // Attach listeners to the new plot instance
            plotDiv.on('plotly_relayout', handleRelayout);
            plotDiv.on('plotly_click', handleClick);

            // Return a cleanup function to remove listeners before the next effect run
            return () => {
                plotDiv.removeAllListeners('plotly_relayout');
                plotDiv.removeAllListeners('plotly_click');
            };
        }
    }, [data, finalLayout, onRelayout, onPointClick]); // Rerun this effect if any of these change

    return <div ref={chartRef} className="plotly-chart-container"></div>;
});

/**
 * Annotations for shutdowns etc
 */
function createEventMarkers(events, theme) {
    const shapes = [], annotations = [];
    const shutdownColor = theme === 'dark' ? '#ef5350' : '#c62828';
    const startColor = '#4caf50';
    const implicitColor = '#ff9800';

    const sortedEvents = [...events].sort((a, b) => new Date(a.time) - new Date(b.time));

    let index = 0;
    for (const event of sortedEvents) {
        const lowerCaseText = event.text.toLowerCase();
        if (lowerCaseText.startsWith('implicit')) {
            const prevEvent = index > 0 ? sortedEvents[index - 1] : null;
            if (prevEvent &&
                prevEvent.text.toLowerCase().startsWith('shutdown') &&
                new Date(prevEvent.time).getTime() === new Date(event.time).getTime())
            {
                index++;
                continue;
            }
        }

        let color, text, hoverText;
        if (lowerCaseText.startsWith('shutdown')) {
            color = shutdownColor;
            text = 'Shutdown';
            hoverText = event.text.replace(/Shutdown:<br>/i, '');
        } else if (lowerCaseText.startsWith('implicit')) {
            color = implicitColor;
            text = 'Implicit Start';
            hoverText = 'Session started after a shutdown.';
        } else {
            color = startColor;
            text = 'Start/Restart';
            hoverText = event.text.replace(/<br>/g, '\n');
        }

        shapes.push({
            type: 'line', x0: event.time, x1: event.time,
            y0: 0, y1: 1, yref: 'paper',
            line: { color, width: 1.5, dash: 'dot' }
        });

        annotations.push({
            x: event.time,
            y: 1,
            yref: 'paper',
            yanchor: 'top',
            xanchor: 'center',
            showarrow: false,
            text: text,
            font: { color, size: 10 },
            hovertext: hoverText,
            bgcolor: 'rgba(0,0,0,0)',
        });
        index++;
    }
    return { shapes, annotations };
};

/**
 * Plotly chart basic settings.
 */
function getBaseLayout(theme) {
    return {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        font: { color: 'var(--text-color)', size: 12 },
        legend: { orientation: 'h', x: 0.01, y: -0.2, xanchor: 'left', yanchor: 'top', font: { size: 12 } },
        xaxis: { title: { text: 'Time', font: { size: 14 }, standoff: 15 }, gridcolor: 'var(--grid-color)', type: 'date', zerolinecolor: 'var(--zeroline-color)', gridwidth: 0.5, griddash: 'dot', tickfont: { size: 12 }, titlefont: { size: 14 } },
        margin: { t: 60, b: 80, l: 70, r: 70 },
        hovermode: 'x unified',
        hoverlabel: { bgcolor: theme === 'dark' ? 'rgba(40, 40, 40, 0.95)' : 'rgba(255, 255, 255, 0.95)', bordercolor: 'var(--primary-color)', font: { color: theme === 'dark' ? '#ffffff' : '#212121', size: 12 } }
    };
}

/**
 * Individual Chart definitions
 */
const CHART_TEMPLATES = {
    SYSTEM_LOAD: {
        title: 'System load utilization',
        layout: {
            yaxis: { title: 'Load (% of a core)', tickformat: ',.2r', automargin: true },
            yaxis2: { title: 'Available memory (KB)', overlaying: 'y', side: 'right', showgrid: false, tickformat: ',.3s', automargin: true }
        },
        data: (metrics) => [
            { ...metrics.sysload, name: 'System Load', yaxis: 'y1', line: { color: 'cyan' } },
            { ...metrics['host:process_time'], name: 'Process Time', yaxis: 'y1', line: { color: 'red' } },
            { ...metrics.memavail, name: 'System Memory', yaxis: 'y2', line: { color: 'yellow' } }
        ]
    },
    MCU_PERFORMANCE: (mcu) => ({
        title: `MCU '${mcu}' performance`,
        layout: {
            yaxis: { title: 'Usage (%)', rangemode: 'tozero', tickformat: ',.2r', automargin: true }
        },
        data: (metrics) => {
            const traces = [
                { ...metrics[`${mcu}:bandwidth`], name: 'Bandwidth', yaxis: 'y1', line: { color: 'green' } },
                { ...metrics[`${mcu}:load`], name: 'MCU Load', yaxis: 'y1', line: { color: 'red' } },
                { ...metrics['host:buffer'], name: 'Host Buffer', yaxis: 'y1', line: { color: 'cyan' } },
                { ...metrics[`${mcu}:mcu_awake`], name: 'Awake Time', yaxis: 'y1', y: metrics[`${mcu}:mcu_awake`]?.y.map(v => v / 5.0 * 100), line: { color: 'yellow' } }
            ];
            return traces;
        }
    }),
    TEMPERATURE: (heater) => ({
        title: `Temperature of ${heater}`,
        layout: {
            yaxis: { title: 'Temperature', tickformat: ',.2r', automargin: true },
            yaxis2: { title: 'PWM', overlaying: 'y', side: 'right', range: [0, 1], autorange: false, showgrid: false, tickformat: ',.0%', automargin: true }
        },
        data: (metrics) => {
            const traces = [
                { ...metrics[`${heater}:temp`], name: `${heater} Temp`, yaxis: 'y1', line: { color: 'orange' } }
            ];
            if (metrics[`${heater}:target`]) {
                traces.push({ ...metrics[`${heater}:target`], name: `${heater} Target`, yaxis: 'y1', line: { color: 'blue' } });
            }
            if (metrics[`${heater}:pwm`]) {
                traces.push({ ...metrics[`${heater}:pwm`], name: `${heater} PWM`, yaxis: 'y2', line: { color: 'darkgray', width: 0.8, opacity: 0.5, dash: 'dash' } });
            }
            return traces;
        }
    }),
    TEMP_SENSOR: (sensor) => ({
        title: `Temperature of Sensor: ${sensor}`,
        layout: { yaxis: { title: 'Temperature (°C)', tickformat: ',.2r', automargin: true } },
        data: (metrics) => [
            { ...metrics[`${sensor}:temp`], name: `${sensor} Temp`, line: { color: 'purple' } }
        ]
    }),
    FREQUENCIES: {
        title: 'MCU frequencies',
        layout: { yaxis: { title: 'Microsecond deviation', tickformat: ',.2r', automargin: true } },
        data: (metrics) => Object.keys(metrics)
            .filter(k => k.endsWith('_deviation'))
            .map(key => ({ ...metrics[key], name: metrics[key].label, mode: 'markers' }))
    },
    CAN_BUS: (can) => ({
        title: `CAN Bus State: ${can}`,
        layout: { yaxis: { title: 'Error Count', rangemode: 'tozero', tickformat: ',.2r', automargin: true } },
        data: (metrics) => [
            { ...metrics[`${can}:rx_error`], name: 'RX Errors', line: { shape: 'hv' } },
            { ...metrics[`${can}:tx_error`], name: 'TX Errors', line: { shape: 'hv' } },
            { ...metrics[`${can}:tx_retries`], name: 'TX Retries', line: { shape: 'hv' } }
        ]
    }),
    ADVANCED_MCU: (mcu, metric) => ({
        title: `MCU ${metric} - ${mcu}`,
        layout: { yaxis: { title: metric, tickformat: ',.2r', automargin: true } },
        data: (metrics) => [{ ...metrics[`${mcu}:${metric}`], name: `${metric} - ${mcu}`, line: { color: 'blue' } }]
    })
};

/**
 * Session Dropdown
 */
const ControlsBar = ({ filename, sessions, selectedSession, onSessionChange, syncZoom, onSyncZoomToggle }) => {
    if (!filename) return null;
    return (
        <div className="file-session-container">
            <div className="session-selector">
                <label htmlFor="session-select">Session:</label>
                {sessions && sessions.length > 1 ? (
                    <select id="session-select" value={selectedSession} onChange={e => onSessionChange(e.target.value)}>
                        <option value="all">All Sessions</option>
                        {sessions.map(session => (
                            <option key={session.id} value={session.id} disabled={session.dataPointCount === 0}>
                                {session.name}
                            </option>
                        ))}
                    </select>
                ) : (
                    <span className="single-session-text">(Single session found)</span>
                )}
            </div>
            <div className="sync-zoom-toggle">
                <label htmlFor="sync-zoom-checkbox">Sync Zoom</label>
                <input type="checkbox" id="sync-zoom-checkbox" checked={syncZoom} onChange={onSyncZoomToggle} />
            </div>
        </div>
    );
};

/**
 * Actual Chart Data Handling
 */
const Dashboard = ({ logData, theme, filename, selectedSession, onSessionChange, syncZoom, onSyncZoomToggle, onPointClick }) => {
  const [xAxisRange, setXAxisRange] = useState(null);

  useEffect(() => {
      setXAxisRange(null);
  }, [logData, selectedSession]);
  
  const handleRelayout = useCallback((eventData) => {
      if (!syncZoom) return;
      if (eventData['xaxis.range[0]']) {
          setXAxisRange([eventData['xaxis.range[0]'], eventData['xaxis.range[1]']]);
      } else if (eventData['xaxis.autorange']) {
          setXAxisRange(null);
      }
  }, [syncZoom]);

  const chartDefinitions = useMemo(() => {
    if (!logData || !logData.metrics) return [];

    const { metrics, events, devices } = logData;
    const { shapes, annotations } = createEventMarkers(events, theme);
    const baseLayout = { shapes, annotations, margin: { t: 50, b: 80, l: 70, r: 70 }, ...getBaseLayout(theme) };
    const definitions = [];

    if (metrics.sysload) definitions.push({ key: 'sysload', ...CHART_TEMPLATES.SYSTEM_LOAD, layout: { ...baseLayout, ...CHART_TEMPLATES.SYSTEM_LOAD.layout }, data: CHART_TEMPLATES.SYSTEM_LOAD.data(metrics) });
    if (devices.mcu) {
        for (const mcu of devices.mcu) {
            if(metrics[`${mcu}:load`]) definitions.push({ key: `mcu-${mcu}`, ...CHART_TEMPLATES.MCU_PERFORMANCE(mcu), layout: { ...baseLayout, ...CHART_TEMPLATES.MCU_PERFORMANCE(mcu).layout }, data: CHART_TEMPLATES.MCU_PERFORMANCE(mcu).data(metrics) })
        }
    }
    if (devices.heaters) {
        for (const heater of devices.heaters) {
            if(metrics[`${heater}:temp`]) definitions.push({ key: `heater-${heater}`, ...CHART_TEMPLATES.TEMPERATURE(heater), layout: { ...baseLayout, ...CHART_TEMPLATES.TEMPERATURE(heater).layout }, data: CHART_TEMPLATES.TEMPERATURE(heater).data(metrics) })
        }
    }
    if (devices.temp_sensors) {
        for (const sensor of devices.temp_sensors) {
            if(metrics[`${sensor}:temp`]) definitions.push({ key: `sensor-${sensor}`, ...CHART_TEMPLATES.TEMP_SENSOR(sensor), layout: { ...baseLayout, ...CHART_TEMPLATES.TEMP_SENSOR(sensor).layout }, data: CHART_TEMPLATES.TEMP_SENSOR(sensor).data(metrics) })
        }
    }
    const freqData = CHART_TEMPLATES.FREQUENCIES.data(metrics);
    if (freqData.length > 0) definitions.push({ key: 'freq', ...CHART_TEMPLATES.FREQUENCIES, layout: { ...baseLayout, ...CHART_TEMPLATES.FREQUENCIES.layout }, data: freqData });

    if (devices.can) {
        for (const can of devices.can) {
            if(metrics[`${can}:rx_error`]) definitions.push({ key: `can-${can}`, ...CHART_TEMPLATES.CAN_BUS(can), layout: { ...baseLayout, ...CHART_TEMPLATES.CAN_BUS(can).layout }, data: CHART_TEMPLATES.CAN_BUS(can).data(metrics) })
        }
    }
    const advancedMetrics = ['srtt', 'rttvar', 'rto', 'ready_bytes', 'bytes_retransmit', 'bytes_invalid'];
    if (devices.mcu) {
        for (const mcu of devices.mcu) {
            for (const metric of advancedMetrics) {
                if (metrics[`${mcu}:${metric}`]) { 
                    const template = CHART_TEMPLATES.ADVANCED_MCU(mcu, metric); 
                    definitions.push({ key: `adv-${mcu}-${metric}`, ...template, layout: { ...baseLayout, ...template.layout }, data: template.data(metrics) }); 
                }
            }
        }
    }

    return definitions;
  }, [logData, theme]);

  if (!logData) return null;

  return (
    <div className="dashboard">
      <ControlsBar
        filename={filename}
        sessions={logData.sessions}
        selectedSession={selectedSession}
        onSessionChange={onSessionChange}
        syncZoom={syncZoom}
        onSyncZoomToggle={onSyncZoomToggle}
      />
      {chartDefinitions.filter(c => c.data && c.data.length > 0 && c.data.some(t => t && t.x && t.x.length > 0)).map((chart) => (
          <div key={chart.key} className="plotly-wrapper">
              <PlotlyChart
                  title={chart.title}
                  data={chart.data.map(t => ({ ...t, type: t.mode === 'markers' ? 'scatter' : 'scatter', mode: t.mode || 'lines', customdata: t.lines }))}
                  layout={chart.layout}
                  theme={theme}
                  onRelayout={handleRelayout}
                  xAxisRange={syncZoom ? xAxisRange : null}
                  onPointClick={onPointClick}
              />
          </div>
      ))}
    </div>
  );
};

/**
 * File Upload
 */
const FileUpload = ({ onFileLoaded }) => {
    const fileInputRef = useRef(null);
    const [isDragging, setIsDragging] = useState(false);

    const handleFileChange = (event) => {
        const file = event.target.files[0];
        if (file) onFileLoaded(file);
    };
    const handleDragOver = (e) => { e.preventDefault(); e.stopPropagation(); };
    const handleDragEnter = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); };
    const handleDragLeave = (e) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); };
    const handleDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            onFileLoaded(e.dataTransfer.files[0]);
        }
    };

    return (
        <div
            className={`file-uploader ${isDragging ? 'drag-over' : ''}`}
            onClick={() => fileInputRef.current.click()}
            onDrop={handleDrop} onDragOver={handleDragOver}
            onDragEnter={handleDragEnter} onDragLeave={handleDragLeave}
        >
            <input type="file" accept=".log,.txt" onChange={handleFileChange} ref={fileInputRef} />
            <p>Click or drag & drop to upload <code>klippy.log</code></p>
        </div>
    );
};

/**
 * Theme Switching
 */
const ThemeSwitcher = ({ theme, toggleTheme }) => (
    <div className="theme-switcher">
        <span>☀️</span>
        <label className="switch">
            <input type="checkbox" onChange={toggleTheme} checked={theme === 'dark'} />
            <span className="slider"></span>
        </label>
        <span>🌙</span>
    </div>
);

/**
 * Log Viewer Component
 */
const LogViewer = ({ logViewerData }) => {
    const { lines, highlight, offset } = logViewerData;
    const highlightRef = useRef(null);

    useEffect(() => {
        if (highlightRef.current) {
            highlightRef.current.scrollIntoView({ behavior: 'auto', block: 'center' });
        }
    }, [lines, highlight, offset]);

    if (!lines || lines.length === 0) {
        return (
            <div className="log-viewer-placeholder">
                Middle-click a point on a chart in the Dashboard to inspect the log.
            </div>
        );
    }

    return (
        <div className="log-viewer-container">
            <pre>
                {lines.map((line, index) => {
                    const lineNumber = offset + index;
                    const isHighlighted = lineNumber === highlight;
                    return (
                        <div
                            key={lineNumber}
                            ref={isHighlighted ? highlightRef : null}
                            className={`log-line ${isHighlighted ? 'highlighted' : ''}`}
                        >
                            <span className="line-number">{lineNumber + 1}</span>
                            <span className="line-content">{line}</span>
                        </div>
                    );
                })}
            </pre>
        </div>
    );
};


/**
 * Final App
 */
const App = () => {
    const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    
    const getTabFromHash = () => {
        const hash = window.location.hash.replace('#', '');
        if (hash === 'logExplorer') return 'logExplorer';
        return 'dashboard';
    };

    const [logData, setLogData] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const [filename, setFilename] = useState('');
    const [theme, setTheme] = useState(systemPrefersDark ? 'dark' : 'light');
    const [selectedSession, setSelectedSession] = useState('all');
    const [syncZoom, setSyncZoom] = useState(true);
    const [activeTab, setActiveTab] = useState(getTabFromHash);
    const [logViewerData, setLogViewerData] = useState({ lines: [], highlight: -1, offset: 0 });
    const [isFiltering, setIsFiltering] = useState(false);
    const workerRef = useRef(null);

    useEffect(() => {
        document.body.className = theme === 'dark' ? 'dark-mode' : '';
    }, [theme]);

    useEffect(() => {
        const handleHashChange = () => {
            setActiveTab(getTabFromHash());
        };
        window.addEventListener('hashchange', handleHashChange);
        return () => window.removeEventListener('hashchange', handleHashChange);
    }, []);

    useEffect(() => {
        const workerUrl = createWorkerBlobURL();
        workerRef.current = new Worker(workerUrl);

        workerRef.current.onmessage = (event) => {
            const { status, type, data, message } = event.data;
            if (status === 'error') {
                setIsLoading(false);
                setIsFiltering(false);
                setError(message);
                return;
            }

            switch (type) {
                case 'parseResult':
                    setIsLoading(false);
                    setLogData(data);
                    setError(null);
                    setSelectedSession('all');
                    window.location.hash = 'dashboard';
                    setLogViewerData({ lines: [], highlight: -1, offset: 0 });
                    break;
                case 'filterResult':
                    setIsFiltering(false);
                    setLogData(prev => ({...prev, ...data}));
                    break;
                case 'logChunk':
                    setLogViewerData(data);
                    break;
            }
        };

        return () => {
            workerRef.current.terminate();
            URL.revokeObjectURL(workerUrl);
        };
    }, []);

    const handleFileLoaded = (file) => {
        setIsLoading(true);
        setLogData(null);
        setError(null);
        setFilename(file.name);
        const reader = new FileReader();
        reader.onload = (e) => {
            workerRef.current.postMessage({
                type: 'parse',
                data: { logContent: e.target.result }
            });
        };
        reader.readAsText(file);
    };
    
    const handleSessionChange = (sessionId) => {
        setSelectedSession(sessionId);
        setIsFiltering(true);
        workerRef.current.postMessage({
            type: 'filter_session',
            data: { sessionId }
        });
    };

    const handlePointClick = useCallback((lineNum) => {
        if (lineNum !== undefined) {
            window.location.hash = 'logExplorer';
            workerRef.current.postMessage({
                type: 'fetch_lines',
                data: { line: lineNum, context: 100 } // Fetch 100 lines before and after
            });
        }
    }, []); // Empty dependency array as it has no external dependencies

    const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'light' : 'dark');
    const handleSyncZoomToggle = () => setSyncZoom(prev => !prev);

    return (
        <div className="app-container">
            <header className="app-header">
                <div className="header-content">
                    <h1>Klipper Log Visualizer 📈</h1>
                    <p>Upload your <code>klippy.log</code> file to analyze printer performance.</p>
                </div>
                <div className="header-controls">
                    <ThemeSwitcher theme={theme} toggleTheme={toggleTheme} />
                    <a
                        href="https://github.com/Sineos/sineos.github.io/tree/main"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="github-link"
                        title="View on GitHub"
                    >
                        <svg height="24" viewBox="0 0 16 16" version="1.1" width="24" aria-hidden="true">
                            <path fillRule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path>
                        </svg>
                    </a>
                </div>
            </header>

            <main>
                <FileUpload onFileLoaded={handleFileLoaded} />
                {isLoading && <div className="status-message">Processing log file... ⚙️</div>}
                {error && <div className="error-message"><strong>Error:</strong> {error}</div>}
                
                {logData && (
                    <div className="tab-container">
                        <div className="tab-navigation">
                            <button onClick={() => window.location.hash = 'dashboard'} className={activeTab === 'dashboard' ? 'active' : ''}>Dashboard</button>
                            <button onClick={() => window.location.hash = 'logExplorer'} className={activeTab === 'logExplorer' ? 'active' : ''}>Log Explorer</button>
                        </div>
                        <div className="tab-content">
                            {isFiltering && <div className="filtering-overlay"><div>Filtering Data...</div></div>}
                            {activeTab === 'dashboard' && (
                                <Dashboard
                                    logData={logData}
                                    theme={theme}
                                    filename={filename}
                                    selectedSession={selectedSession}
                                    onSessionChange={handleSessionChange}
                                    syncZoom={syncZoom}
                                    onSyncZoomToggle={handleSyncZoomToggle}
                                    onPointClick={handlePointClick}
                                />
                            )}
                            {activeTab === 'logExplorer' && (
                                <LogViewer logViewerData={logViewerData} />
                            )}
                        </div>
                    </div>
                )}
            </main>
        </div>
    );
};

// Render the main App component to the DOM
const container = document.getElementById('root');
const root = ReactDOM.createRoot(container);
root.render(<App />);