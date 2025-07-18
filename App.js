// ======================================================================
//  UI & APP LOGIC: React Application
// ======================================================================

const { useState, useEffect, useRef, useMemo, useCallback } = React;

/**
 * Creates a self-contained Web Worker from the globally available
 * parsing functions in logParser.js.
 */
function createWorkerBlobURL() {
    const workerLogicString = `
        const LOGIC_CONSTANTS = {
            KEYS_TO_PREFIX: new Set(${JSON.stringify(Array.from(LOGIC_CONSTANTS.KEYS_TO_PREFIX))}),
            MAXBANDWIDTH: ${LOGIC_CONSTANTS.MAXBANDWIDTH},
            MAXBUFFER: ${LOGIC_CONSTANTS.MAXBUFFER},
            STATS_INTERVAL: ${LOGIC_CONSTANTS.STATS_INTERVAL},
            TASK_MAX: ${LOGIC_CONSTANTS.TASK_MAX}
        };

        const findPrintResets = ${findPrintResets.toString()};
        const parseKlipperLog = ${parseKlipperLog.toString()};

        self.onmessage = (event) => {
            const { logContent } = event.data;
            try {
                const processedData = parseKlipperLog(logContent);
                self.postMessage({ status: 'success', data: processedData });
            } catch (error) {
                self.postMessage({ status: 'error', message: error.message });
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
const PlotlyChart = React.memo(({ data, layout, title, theme, onRelayout, xAxisRange }) => {
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
            const plotConfig = { responsive: true, displayModeBar: true, displaylogo: false, doubleClick: 'reset+autosize', modeBarButtonsToRemove: ['lasso2d', 'select2d'] };
            Plotly.react(chartRef.current, data, finalLayout, plotConfig);
        }
    }, [data, finalLayout]);

    useEffect(() => {
        const plotDiv = chartRef.current;
        if (!plotDiv || !onRelayout) return;

        const handler = (eventData) => {
            if (Object.keys(eventData).length > 0 && !eventData['dragmode']) {
                 onRelayout(eventData);
            }
        };

        plotDiv.on('plotly_relayout', handler);
        return () => {
            plotDiv.removeAllListeners('plotly_relayout');
        };
    }, [onRelayout]);

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

    sortedEvents.forEach((event, index) => {
        const lowerCaseText = event.text.toLowerCase();
        if (lowerCaseText.startsWith('implicit')) {
            const prevEvent = index > 0 ? sortedEvents[index - 1] : null;
            if (prevEvent &&
                prevEvent.text.toLowerCase().startsWith('shutdown') &&
                new Date(prevEvent.time).getTime() === new Date(event.time).getTime())
            {
                return;
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
    });
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
  SYSTEM_LOAD: { title: 'System load utilization', layout: { yaxis: { title: 'Load (% of a core)', tickformat: ',.2r', automargin: true }, yaxis2: { title: 'Available memory (KB)', overlaying: 'y', side: 'right', showgrid: false, tickformat: ',.3s', automargin: true } }, data: (metrics) => [ { ...metrics.sysload, name: 'System Load', yaxis: 'y1', line: { color: 'cyan' } }, { ...metrics['host:process_time'], name: 'Process Time', yaxis: 'y1', line: { color: 'red' } }, { ...metrics.memavail, name: 'System Memory', yaxis: 'y2', line: { color: 'yellow' } } ] },
  MCU_PERFORMANCE: (mcu) => ({ title: `MCU '${mcu}' performance`, layout: { yaxis: { title: 'Usage (%)', rangemode: 'tozero', tickformat: ',.2r', automargin: true } }, data: (metrics) => [ { ...metrics[`${mcu}:bandwidth`], name: 'Bandwidth', line: { color: 'green' } }, { ...metrics[`${mcu}:load`], name: 'MCU Load', line: { color: 'red' } }, { ...metrics['host:buffer'], name: 'Host Buffer', line: { color: 'cyan' } }, { ...metrics[`${mcu}:mcu_awake`], name: 'Awake Time', y: metrics[`${mcu}:mcu_awake`]?.y.map(v => v / 5.0 * 100), line: { color: 'yellow' } } ] }),
  TEMPERATURE: (heater) => ({ title: `Temperature of ${heater}`, layout: { yaxis: { title: 'Temperature', tickformat: ',.2r', automargin: true }, yaxis2: { title: 'PWM', overlaying: 'false', side: 'right', range: [0, 1], autorange: false, showgrid: false, tickformat: ',.0%', automargin: true } }, data: (metrics) => { const traces = [ { ...metrics[`${heater}:temp`], name: `${heater} Temp`, yaxis: 'y1', line: { color: 'orange' } } ]; if (metrics[`${heater}:target`]) traces.push({ ...metrics[`${heater}:target`], name: `${heater} Target`, yaxis: 'y1', line: { color: 'blue' } }); if (metrics[`${heater}:pwm`]) traces.push({ ...metrics[`${heater}:pwm`], name: `${heater} PWM`, yaxis: 'y2', line: { color: 'darkgray', width: 0.8, opacity: 0.5, dash: 'dash' } }); return traces; } }),
  FREQUENCIES: { title: 'MCU frequencies', layout: { yaxis: { title: 'Microsecond deviation', tickformat: ',.2r', automargin: true } }, data: (metrics) => Object.keys(metrics).filter(k => k.endsWith('_deviation')).map(key => ({ ...metrics[key], name: metrics[key].label, mode: 'markers' })) },
  CAN_BUS: (can) => ({ title: `CAN Bus State: ${can}`, layout: { yaxis: { title: 'Error Count', rangemode: 'tozero', tickformat: ',.2r', automargin: true } }, data: (metrics) => [ { ...metrics[`${can}:rx_error`], name: 'RX Errors', line: { shape: 'hv' } }, { ...metrics[`${can}:tx_error`], name: 'TX Errors', line: { shape: 'hv' } }, { ...metrics[`${can}:tx_retries`], name: 'TX Retries', line: { shape: 'hv' } } ] }),
  ADVANCED_MCU: (mcu, metric) => ({ title: `MCU ${metric} - ${mcu}`, layout: { yaxis: { title: metric, tickformat: ',.2r', automargin: true } }, data: (metrics) => [{ ...metrics[`${mcu}:${metric}`], name: `${metric} - ${mcu}`, line: { color: 'blue' } }] })
};

/**
 * Session Dropdown
 */
const ControlsBar = ({ filename, sessions, selectedSession, onSessionChange, syncZoom, onSyncZoomToggle }) => {
    if (!filename) return null;
    return (
        <div className="file-session-container">
            <div className="session-selector">
                <label htmlFor="session-select">{`Select session from '${filename}':`}</label>
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
const Dashboard = ({ logData, theme, filename, selectedSession, onSessionChange, syncZoom, onSyncZoomToggle }) => {
  const [xAxisRange, setXAxisRange] = useState(null);

  useEffect(() => {
      setXAxisRange(null);
  }, [logData, selectedSession]);

  const filteredData = useMemo(() => {
    if (!logData) return null;
    let sourceData;
    if (selectedSession === 'all') {
        sourceData = {
            metrics: logData.metrics,
            events: logData.events,
            devices: logData.devices
        };
    } else {
        const session = logData.sessions.find(s => s.id == selectedSession);
        if (!session) return null;
        const { startTime, endTime } = session;
        const start = new Date(startTime).getTime();
        const end = endTime ? new Date(endTime).getTime() : Number.MAX_SAFE_INTEGER;
        const filteredMetrics = {};
        for (const key in logData.metrics) {
            const metric = logData.metrics[key];
            const newX = [], newY = [];
            for (let i = 0; i < metric.x.length; i++) {
                const time = new Date(metric.x[i]).getTime();
                if (time >= start && time <= end) {
                    newX.push(metric.x[i]);
                    newY.push(metric.y[i]);
                }
            }
            if (newX.length > 0) filteredMetrics[key] = { ...metric, x: newX, y: newY };
        }
        sourceData = {
            metrics: filteredMetrics,
            events: session.events,
            devices: session.devices
        };
    }
    return sourceData;
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
    if (!filteredData || !filteredData.metrics) return [];

    const { metrics, events, devices } = filteredData;
    const { shapes, annotations } = createEventMarkers(events, theme);
    const baseLayout = { shapes, annotations, margin: { t: 50, b: 80, l: 70, r: 70 }, ...getBaseLayout(theme) };
    const definitions = [];

    if (metrics.sysload) definitions.push({ key: 'sysload', ...CHART_TEMPLATES.SYSTEM_LOAD, layout: { ...baseLayout, ...CHART_TEMPLATES.SYSTEM_LOAD.layout }, data: CHART_TEMPLATES.SYSTEM_LOAD.data(metrics) });
    if (devices.mcu) devices.mcu.forEach(mcu => { if(metrics[`${mcu}:load`]) definitions.push({ key: `mcu-${mcu}`, ...CHART_TEMPLATES.MCU_PERFORMANCE(mcu), layout: { ...baseLayout, ...CHART_TEMPLATES.MCU_PERFORMANCE(mcu).layout }, data: CHART_TEMPLATES.MCU_PERFORMANCE(mcu).data(metrics) }) });
    if (devices.heaters) devices.heaters.forEach(heater => { if(metrics[`${heater}:temp`]) definitions.push({ key: `heater-${heater}`, ...CHART_TEMPLATES.TEMPERATURE(heater), layout: { ...baseLayout, ...CHART_TEMPLATES.TEMPERATURE(heater).layout }, data: CHART_TEMPLATES.TEMPERATURE(heater).data(metrics) }) });
    const freqData = CHART_TEMPLATES.FREQUENCIES.data(metrics);
    if (freqData.length > 0) definitions.push({ key: 'freq', ...CHART_TEMPLATES.FREQUENCIES, layout: { ...baseLayout, ...CHART_TEMPLATES.FREQUENCIES.layout }, data: freqData });
    if (devices.can) devices.can.forEach(can => { if(metrics[`${can}:rx_error`]) definitions.push({ key: `can-${can}`, ...CHART_TEMPLATES.CAN_BUS(can), layout: { ...baseLayout, ...CHART_TEMPLATES.CAN_BUS(can).layout }, data: CHART_TEMPLATES.CAN_BUS(can).data(metrics) }) });
    const advancedMetrics = ['srtt', 'rttvar', 'rto', 'ready_bytes', 'upcoming_bytes'];
    if (devices.mcu) devices.mcu.forEach(mcu => advancedMetrics.forEach(metric => { if (metrics[`${mcu}:${metric}`]) { const template = CHART_TEMPLATES.ADVANCED_MCU(mcu, metric); definitions.push({ key: `adv-${mcu}-${metric}`, ...template, layout: { ...baseLayout, ...template.layout }, data: template.data(metrics) }); } }));

    return definitions;
  }, [filteredData, theme]);

  if (!filteredData) return null;

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h2>Log Analysis Dashboard</h2>
      </div>
      <ControlsBar
        filename={filename}
        sessions={logData.sessions}
        selectedSession={selectedSession}
        onSessionChange={onSessionChange}
        syncZoom={syncZoom}
        onSyncZoomToggle={onSyncZoomToggle}
      />
      {chartDefinitions.filter(c => c.data && c.data.length > 0 && c.data.some(t => t && t.x && t.x.length > 0)).map((chart) => (
          <PlotlyChart
            key={chart.key}
            title={chart.title}
            // Do not use scattergl as it will fail in Chrome and Edge
            data={chart.data.map(t => ({ ...t, type: t.mode === 'markers' ? 'scatter' : 'scatter', mode: t.mode || 'lines' }))}
            layout={chart.layout}
            theme={theme}
            onRelayout={handleRelayout}
            xAxisRange={syncZoom ? xAxisRange : null}
          />
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

    const handleClick = () => fileInputRef.current.click();
    const handleFileChange = (event) => {
        const file = event.target.files[0];
        if (file) onFileLoaded(file);
    };
    const handleDragOver = (event) => {
        event.preventDefault();
        event.stopPropagation();
    };
    const handleDragEnter = (event) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDragging(true);
    };
    const handleDragLeave = (event) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDragging(false);
    };
    const handleDrop = (event) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDragging(false);
        const files = event.dataTransfer.files;
        if (files && files.length > 0) onFileLoaded(files[0]);
    };

    return (
        <div
            className={`file-uploader ${isDragging ? 'drag-over' : ''}`}
            onClick={handleClick}
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
 * Final App
 */
const App = () => {
    const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const [logData, setLogData] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState(null);
    const [filename, setFilename] = useState('');
    const [theme, setTheme] = useState(systemPrefersDark ? 'dark' : 'light');
    const [selectedSession, setSelectedSession] = useState('all');
    const [syncZoom, setSyncZoom] = useState(true);
    const workerRef = useRef(null);

    useEffect(() => {
        document.body.classList.toggle('dark-mode', theme === 'dark');
        document.body.classList.toggle('light-mode', theme === 'light');
    }, [theme]);

    useEffect(() => {
        const workerUrl = createWorkerBlobURL();
        workerRef.current = new Worker(workerUrl);
        workerRef.current.onmessage = (event) => {
            const { status, data, message } = event.data;
            setIsLoading(false);
            if (status === 'success') {
                setLogData(data);
                setError(null);
                setSelectedSession('all');
            } else {
                setLogData(null);
                setError(message);
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
        reader.onload = (e) => workerRef.current.postMessage({ logContent: e.target.result });
        reader.readAsText(file);
    };

    const toggleTheme = () => setTheme(prev => prev === 'dark' ? 'light' : 'dark');
    const handleSyncZoomToggle = () => setSyncZoom(prev => !prev);

    return (
        <React.Fragment>
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

                <FileUpload onFileLoaded={handleFileLoaded} />
                {isLoading && <div className="status-message">Processing log file... ⚙️</div>}
                {error && <div className="error-message"><strong>Error:</strong> {error}</div>}
                {logData && <Dashboard
                    logData={logData}
                    theme={theme}
                    filename={filename}
                    selectedSession={selectedSession}
                    onSessionChange={setSelectedSession}
                    syncZoom={syncZoom}
                    onSyncZoomToggle={handleSyncZoomToggle}
                />}
            </div>
        </React.Fragment>
    );
};

// Render the main App component to the DOM
const container = document.getElementById('root');
const root = ReactDOM.createRoot(container);
root.render(<App />);