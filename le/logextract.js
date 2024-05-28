/* eslint-disable max-params */
/* eslint-disable max-len */
/* eslint-disable camelcase */

function format_comment(line_num, line) {
  return `# ${line_num.toString().padStart(6, '0')}: ${line}`;
}

class IndexedDBManager {
  constructor(dbName, version = 1, callback) {
    this.dbName = dbName;
    this.version = version;
    this.db = null;

    this.init(callback);
  }

  init(callback) {
    const request = indexedDB.open(this.dbName, this.version);

    request.onupgradeneeded = (event) => {
      this.db = event.target.result;
      if (!this.db.objectStoreNames.contains('shutdown')) {
        this.db.createObjectStore('shutdown');
      }
      if (!this.db.objectStoreNames.contains('config')) {
        this.db.createObjectStore('config');
      }
      if (!this.db.objectStoreNames.contains('gcode')) {
        this.db.createObjectStore('gcode');
      }
    };

    request.onsuccess = (event) => {
      this.db = event.target.result;
      if (callback) {
        callback();
      }
    };

    request.onerror = (event) => {
      console.error('Database error:', event.target.errorCode);
    };
  }

    closeConnection() {
        this.isClosing = true;
        if (this.db) {
            this.db.close();
            this.db = null;
            setTimeout(() => this.isClosing = false, 500);
        }
    }

  save(storeName, key, data) {
    if (!this.db) {
      return;
    }

    const transaction = this.db.transaction([storeName], 'readwrite');
    const store = transaction.objectStore(storeName);

    store.put(data, key);

    transaction.onerror = (event) => {
      console.error('Transaction error:', event.target.error);
    };
  }

  getAllKeys(storeName, callback) {
    if (!this.db) {
      return;
    }

    const transaction = this.db.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);
    const keysRequest = store.getAllKeys();

    keysRequest.onsuccess = () => {
      callback(keysRequest.result);
    };

    keysRequest.onerror = (event) => {
      console.error('Keys request error:', event.target.errorCode);
    };
  }

  get(storeName, key, callback) {
    if (!this.db) {
      return;
    }

    const transaction = this.db.transaction([storeName], 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.get(key);

    request.onsuccess = () => {
      callback(request.result);
    };

    request.onerror = (event) => {
      console.error('Get request error:', event.target.errorCode);
    };
  }

  checkIfDatabaseExists(callback) {
    const request = indexedDB.open(this.dbName);

    let existed = true;
    request.onupgradeneeded = () => {
      existed = false;
    };
    request.onsuccess = () => {
      request.result.close();
      callback(existed);
    };
    request.onerror = (event) => {
      console.error('Database check error:', event.target.errorCode);
      callback(false);
    };
  }

  deleteDatabase(callback) {
    const deleteRequest = indexedDB.deleteDatabase(this.dbName);

    deleteRequest.onsuccess = () => {
      console.log('Database deleted successfully');
      callback(true);
    };

    deleteRequest.onerror = (event) => {
      console.error('Error deleting database:', event.target.errorCode);
      callback(false);
    };

    deleteRequest.onblocked = (event) => {
      console.warn('Database deletion blocked:', event);
      callback(false);
    };
  }
  
    deleteAllStores(callback) {
        if (!this.db) {
            callback(false, "No active database connection");
            return;
        }

        const transaction = this.db.transaction(this.db.objectStoreNames, 'readwrite');
        const storeNames = Array.from(this.db.objectStoreNames);

        let storesDeleted = 0;
        storeNames.forEach(storeName => {
            const store = transaction.objectStore(storeName);
            const clearRequest = store.clear();

            clearRequest.onsuccess = () => {
                storesDeleted++;
                if (storesDeleted === storeNames.length) {
                    callback(true);
                }
            };

            clearRequest.onerror = (event) => {
                console.error(`Error clearing store '${storeName}':`, event.target.error);
                callback(false, event.target.error);
            };
        });
    }
}






class DisplayManager {
  constructor() {
    this.dbManager = new IndexedDBManager('LogDatabase');
    this.shutdownData = {};
    this.configData = {};
    this.gcodeData = {};
  }

  collectShutdown(filename, content) {
    this.shutdownData[filename] = content;
    this.dbManager.save('shutdown', filename, content); 
  }

  collectConfig(filename, content) {
    this.shutdownData[filename] = content;
    this.dbManager.save('config', filename, content);
  }

  collectGcode(filename, content) {
    this.shutdownData[filename] = content;
    this.dbManager.save('gcode', filename, content);
  }

  show() {
    const openHTMLIfKeysExist = (storeName, htmlFile) => {
      this.dbManager.getAllKeys(storeName, (keys) => {
        if (keys.length > 0) {
          window.open(htmlFile, '_blank');
        }
      });
    };

    openHTMLIfKeysExist('shutdown', 'shutdown.html');
    openHTMLIfKeysExist('shutdown', 'plot.html');
    openHTMLIfKeysExist('config', 'config.html');
    openHTMLIfKeysExist('gcode', 'gcode.html');
  }
}

const sentRegex = /^(?:Sent|mcu\s'(\w+)': Sent) \d+ ([0-9.]+) ([0-9.]+) \d+: seq: (\w+\(\d+\)), (.+)$/;
const receiveRegex = /^(?:Receive|mcu\s'(\w+)': Receive): \d+ ([0-9.]+) ([0-9.]+) \d+: seq: (\w+\(\d+\)), (.+)$/;
const shutdownRegex = /static_string_id=([\w\s]+)/;
const statsRegex = /^Stats ([0-9.]+): (.+)$/;

class PlotData {
  constructor() {
    this.data = {
      MCUs: {},
      Events: []
    };
  }

  parseLine(line) {
    let match;

    if ((match = sentRegex.exec(line))) {
      this.parseSentLine(match);
    } else if ((match = receiveRegex.exec(line))) {
      this.parseReceiveLine(match);
    } else if ((match = statsRegex.exec(line))) {
      this.parseStatsLine(match);
    }
  }

  parseSentLine(match) {
    const mcu = match[1] || 'mcu';
    const expectedReceivedTS = parseFloat(match[2]);
    const actuallySentTS = parseFloat(match[3]);
    const data = match[0].slice(0, 150);

    if (!this.data.MCUs[mcu]) {
      this.data.MCUs[mcu] = { sent: [], receive: [] }; 
    }

    this.data.MCUs[mcu].sent.push({
      expectedReceivedTS,
      actuallySentTS,
      data
    });
  }

  parseReceiveLine(match) {
    const mcu = match[1] || 'mcu';
    const actuallyReadTS = parseFloat(match[2]);
    const precedingSentTS = parseFloat(match[3]);
    const data = match[0].slice(0, 150);
    const shutdownMatch = data.match(shutdownRegex);

    if (!this.data.MCUs[mcu]) {
      this.data.MCUs[mcu] = { sent: [], receive: [] }; 
    }

    const receiveData = {
      actuallyReadTS,
      precedingSentTS,
      data
    };

    if (shutdownMatch) {
      this.data.Events.push({
        mcu,
        actuallyReadTS,
        precedingSentTS,
        data,
        shutdownEvent: shutdownMatch[1]
      });
    } else {
      this.data.MCUs[mcu].receive.push(receiveData);
    }
  }

  parseStatsLine(match) {
    const statsTS = parseFloat(match[1]);
    const data = match[0].slice(0, 150);

    if (!this.data.stats) {
      this.data.stats = []; 
    }

    this.data.stats.push({
      statsTS,
      data
    });
  }

  getParsedData() {
    return this.data;
  }

  generateGraphs() {
    const graphs = [];

    for (const mcu in this.data.MCUs) {
      const mcuData = this.data.MCUs[mcu];

      const sentTrace = {
        x: mcuData.sent.map((d) => d.expectedReceivedTS),
        y: Array(mcuData.sent.length).fill(1),
        mode: 'markers',
        name: 'Sent',
        text: mcuData.sent.map((d) => d.data),
        hoverinfo: 'x+text'
      };

      const receiveTrace = {
        x: mcuData.receive.map((d) => d.actuallyReadTS),
        y: Array(mcuData.receive.length).fill(1),
        mode: 'markers',
        name: 'Receive',
        text: mcuData.receive.map((d) => d.data),
        hoverinfo: 'x+text'
      };

      const statsTrace = {
        x: this.data.stats.map((d) => d.statsTS),
        y: Array(this.data.stats.length).fill(1),
        mode: 'markers',
        name: 'Stats',
        text: this.data.stats.map((d) => d.data),
        hoverinfo: 'x+text'
      };

      const layout = {
        title: `MCU ${mcu}`,
        xaxis: { title: 'Timestamp' },
        yaxis: { title: 'Events', tickvals: [1], ticktext: ['Event'] },
        annotations: this.data.Events.filter((event) => event.mcu === mcu).map((event) => ({
          x: event.actuallyReadTS,
          y: 1,
          text: event.shutdownEvent,
          showarrow: true,
          arrowhead: 7,
          ax: 0,
          ay: -40
        }))
      };

      const config = { responsive: true };

      graphs.push({ data: [sentTrace, receiveTrace, statsTrace], layout, config });
    }
    
    return graphs;
  }

  generateRTTGraphs() {
    const rttGraphs = [];

    for (const mcu in this.data.MCUs) {
      const mcuData = this.data.MCUs[mcu];
      const matchingPairs = [];
      const unmatchedSent = [...mcuData.sent];
      const unmatchedReceive = [...mcuData.receive];

      mcuData.receive.forEach((receiveData) => {
        const sentData = mcuData.sent.find((sent) => sent.expectedReceivedTS === receiveData.precedingSentTS);

        if (sentData) {
          const roundTripTime = receiveData.actuallyReadTS - sentData.actuallySentTS;

          matchingPairs.push({
            expectedReceivedTS: sentData.expectedReceivedTS,
            actuallyReadTS: receiveData.actuallyReadTS,
            roundTripTime,
            dataSent: sentData.data,
            dataReceived: receiveData.data
          });
          // Remove matched sentData and receiveData from unmatched arrays
          const sentIndex = unmatchedSent.indexOf(sentData);

          if (sentIndex > -1) {
            unmatchedSent.splice(sentIndex, 1);
          }
          const receiveIndex = unmatchedReceive.indexOf(receiveData);

          if (receiveIndex > -1) {
            unmatchedReceive.splice(receiveIndex, 1);
          }
        }
      });

      const sentTrace = {
        x: matchingPairs.map((d) => d.expectedReceivedTS),
        y: Array(matchingPairs.length).fill(1),
        mode: 'markers',
        name: 'Sent',
        text: matchingPairs.map((d) => d.dataSent),
        hoverinfo: 'x+text',
        marker: { color: 'blue' }
      };

      const receiveTrace = {
        x: matchingPairs.map((d) => d.actuallyReadTS),
        y: Array(matchingPairs.length).fill(1),
        mode: 'markers',
        name: 'Receive',
        error_y: {
          type: 'data',
          symmetric: false,
          array: matchingPairs.map((d) => d.roundTripTime),
          arrayminus: matchingPairs.map(() => 0)
        },
        text: matchingPairs.map((d) => `RTT: ${d.roundTripTime}<br>Received: ${d.dataReceived}<br>Answer to: ${d.dataSent}`),
        hoverinfo: 'x+text',
        marker: { color: 'red' }
      };

      const unmatchedSentTrace = {
        x: unmatchedSent.map((d) => d.expectedReceivedTS),
        y: Array(unmatchedSent.length).fill(1),
        mode: 'markers',
        name: 'Unmatched Sent',
        text: unmatchedSent.map((d) => d.data),
        hoverinfo: 'x+text',
        marker: { color: 'lightblue' }
      };

      const unmatchedReceiveTrace = {
        x: unmatchedReceive.map((d) => d.actuallyReadTS),
        y: Array(unmatchedReceive.length).fill(1),
        mode: 'markers',
        name: 'Unmatched Receive',
        text: unmatchedReceive.map((d) => d.data),
        hoverinfo: 'x+text',
        marker: { color: 'lightcoral' }
      };

      const statsTrace = {
        x: this.data.stats.map((d) => d.statsTS),
        y: Array(this.data.stats.length).fill(1),
        mode: 'markers',
        name: 'Stats',
        text: this.data.stats.map((d) => d.data),
        hoverinfo: 'x+text'
      };

      const layout = {
        title: `RTT for MCU ${mcu}`,
        xaxis: { title: 'Timestamp' },
        yaxis: { title: 'Events', tickvals: [1], ticktext: ['Event'] },
        annotations: this.data.Events.filter((event) => event.mcu === mcu).map((event) => ({
          x: event.actuallyReadTS,
          y: 1,
          text: event.shutdownEvent,
          showarrow: true,
          arrowhead: 7,
          ax: 0,
          ay: -40
        }))
      };

      const config = { responsive: true };

      rttGraphs.push({ data: [sentTrace, receiveTrace, unmatchedSentTrace, unmatchedReceiveTrace, statsTrace], layout, config });
    }
    
    return rttGraphs;
  }
}


class GatherConfig {
  constructor(configs, line_num, recent_lines, logname) {
    this.configs = configs;
    this.line_num = line_num;
    this.config_num = Object.keys(configs).length + 1;
    this.filename = `${logname}.config${this.config_num.toString().padStart(4, '0')}.cfg`;
    this.config_lines = [];
    this.comments = [];
  }

  add_line(line_num, line) {
    if (line !== '=======================') {
      this.config_lines.push(line);

      return true;
    }
    this.finalize();

    return false;
  }

  finalize() {
    const lines = this.config_lines.join('\n'); // Replaces tuple creation
    let ch = this.configs[lines];

    if (!ch) {
      this.configs[lines] = ch = this;
    } else {
      ch.comments.push(...this.comments);
    }

    ch.comments.push(format_comment(this.line_num, 'config file'));
  }

  add_comment(comment) {
    if (comment !== null) {
      this.comments.push(comment);
    }
  }

  write_file() {
    const outputText = _.chain(this.comments)
      .concat(this.config_lines)
      .map((line) => `${line}\n`)
      .join('')
      .value();

    displayManager.collectConfig(this.filename, outputText);
  }
}

class TMCUartHelper {
  _calc_crc8(data) {
    let crc = 0;
    const polynomial = 0x07; // CRC-8/ATM polynomial

    for (const byte of data) {
      let b = byte; // Create a separate variable to store the modified value

      for (let i = 0; i < 8; i++) {
        if ((crc >> 7) ^ (b & 0x01)) {
          crc = (crc << 1) ^ polynomial;
        } else {
          crc <<= 1;
        }
        crc &= 0xFF;
        b >>= 1;
      }
    }

    return crc;
  }

  _add_serial_bits(data) {
    let out = 0n;
    let pos = 0n;

    for (const d of data) {
      const b = ((BigInt(d) << 1n) | 0x200n); // Set MSB to 1 and shift left by 1 bit

      out |= b << pos;
      pos += 10n; // Increment by 10 for the added serial bit
    }

    const byteCount = Math.ceil(Number((pos + 7n) / 8n));
    const res = new Uint8Array(byteCount);

    for (let i = 0n; i < byteCount; i++) {
      res[i] = Number((out >> (i * 8n)) & 0xffn);
    }

    return res;
  }


  _encode_read(sync, addr, reg) {
    const msgTemp = new Uint8Array([sync, addr, reg]);
    const msg = new Uint8Array(4);
    const crc = [];

    crc.push(this._calc_crc8(msgTemp)); // Calculate CRC and push it to the crc array
    msg.set(msgTemp, 0); // Copy the message bytes to the msg array
    msg.set(crc, 3); // Set the CRC byte at the end of the msg array

    return this._add_serial_bits(msg);
  }

  _encode_write(sync, addr, reg, val) {
    const msgTemp = new Uint8Array(7);
    const msg = new Uint8Array(8); // Increased size to accommodate the CRC byte
    const crc = [];

    msgTemp[0] = sync;
    msgTemp[1] = addr;
    msgTemp[2] = reg;
    msgTemp.set(new Uint8Array([(val >> 24) & 0xff, (val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff]), 3);

    crc.push(this._calc_crc8(msgTemp)); // Calculate CRC and push it to the crc array

    msg.set(msgTemp, 0); // Copy the message bytes to the msg array
    msg.set(crc, 7); // Set the CRC byte at the end of the msg array


    return this._add_serial_bits(msg);
  }

  // Utility function to check if two arrays are equal
  arraysEqual(arr1, arr2) {
    if (arr1.length !== arr2.length) {
      return false;
    }
    for (let i = 0; i < arr1.length; i++) {
      if (arr1[i] !== arr2[i]) {
        return false;
      }
    }

    return true;
  }

  _decode_read(data) {
    if (data.length !== 5) {
      return '';
    }

    let mval = BigInt(0);

    // Construct mval from bytes
    for (let i = 0; i < data.length; i++) {
      mval |= BigInt(data[i]) << BigInt(i * 8);
    }

    const addr = Number((mval >> BigInt(11)) & BigInt(0xff));
    const reg = Number((mval >> BigInt(21)) & BigInt(0xff));

    // Verify start/stop bits and crc
    const encoded_data = this._encode_read(0xf5, addr, reg);

    if (!this.arraysEqual(data, encoded_data)) {
      return 'Invalid: ' + this.pretty_print(addr, reg);
    }

    return this.pretty_print(addr, reg);
  }


  _decode_reg(data) {
    if (data.length !== 10) {
      return null;
    }

    let mval = BigInt(0);

    // Construct mval from bytes in little-endian order
    for (let i = 0; i < data.length; i++) {
      mval |= BigInt(data[i]) << BigInt(8 * i);
    }

    const addr = Number((mval >> BigInt(11)) & BigInt(0xff));
    const reg = Number((mval >> BigInt(21)) & BigInt(0xff));
    const val = Number((((mval >> BigInt(31)) & BigInt(0xff)) << BigInt(24))
                      | (((mval >> BigInt(41)) & BigInt(0xff)) << BigInt(16))
                      | (((mval >> BigInt(51)) & BigInt(0xff)) << BigInt(8))
                      | ((mval >> BigInt(61)) & BigInt(0xff)));

    let sync = 0xf5;

    if (addr === 0xff) {
      sync = 0x05;
    }

    const encoded_data = this._encode_write(sync, addr, reg, val);

    if (!this.arraysEqual(data, encoded_data)) {
      return 'Invalid:' + this.pretty_print(addr, reg, val);
    }

    return this.pretty_print(addr, reg, val);
  }

  pretty_print(addr, reg, val = null) {
    if (val === null) {
      return `(${reg.toString(16)}@${addr.toString(16)})`;
    }
    if (reg & 0x80) {
      return `(${(reg & ~0x80).toString(16)}@${addr.toString(16)}=${val.toString(16).padStart(8, '0')})`;
    }

    return `(${reg.toString(16)}@${addr.toString(16)}==${val.toString(16).padStart(8, '0')})`;
  }

  parse_msg(msg) {
    const data = msg;

    if (data.length === 10) {
      return this._decode_reg(data);
    } else if (data.length === 5) {
      return this._decode_read(data);
    } else if (data.length === 0) {
      return '';
    }

    return '(length?)';
  }
}

function add_high_bits(val, ref, mask) {
  const half = Math.floor((mask + 1) / 2);

  let diff = val - (ref & mask);

  if (diff < -half) {
    diff += mask + 1;
  } else if (diff > half) {
    diff -= mask + 1;
  }

  return ref + diff;
}

const count_s = '(?<count>[0-9]+)';
const time_s = '(?<time>[0-9]+\\.[0-9]+)';
const esttime_s = '(?<esttime>[0-9]+\\.[0-9]+)';
const shortseq_s = '(?<shortseq>[0-9a-f])';

const sent_r = new RegExp('^Sent ' + count_s + ' ' + esttime_s + ' ' + time_s
                          + ' [0-9]+: seq: 1' + shortseq_s + ',');

const receive_r = new RegExp('^Receive: ' + count_s + ' ' + time_s + ' ' + esttime_s
                             + ' [0-9]+: seq: 1' + shortseq_s + ',');

class MCUSentStream {
  constructor(mcu, count) {
    this.mcu = mcu;
    this.sent_stream = [];
    this.send_count = count;
  }

  parse_line(line_num, line) {
    const m = sent_r.exec(line);

    if (m !== null) {
      const shortseq = parseInt(m.groups.shortseq, 16);
      let seq = this.mcu.shutdown_seq + parseInt(m.groups.count, 10) - this.send_count;


      seq = add_high_bits(shortseq, seq, 0xf);

      const ts = parseFloat(m.groups.time);
      const esttime = parseFloat(m.groups.esttime);

      // Construct to tuple like key
      const tupleKey = `${esttime},${seq & 0xf}`;

      // Assign it to the sent_time_to_seq object
      this.mcu.sent_time_to_seq[tupleKey] = seq;
      this.mcu.sent_seq_to_time[seq] = ts;

      line = this.mcu.annotate(line, seq, ts);
      this.sent_stream.push([ts, line_num, line]);

      return [true, null];
    }

    return this.mcu.parse_line(line_num, line); // Delegate to MCU's parsing
  }

  get_lines() {
    return this.sent_stream;
  }
}

class MCUReceiveStream {
  constructor(mcu) {
    this.mcu = mcu;
    this.receive_stream = [];
  }

  parse_line(line_num, line) {
    const m = receive_r.exec(line);

    if (m !== null) {
      const shortseq = parseInt(m.groups.shortseq, 16);
      const ts = parseFloat(m.groups.time);
      const esttime = parseFloat(m.groups.esttime);
      const seqKey = [esttime, (shortseq - 1) & 0xf].join(',');
      const seq = this.mcu.sent_time_to_seq[seqKey]; // Accessing the property directly

      if (seq !== undefined) {
        this.mcu.receive_seq_to_time[seq + 1] = ts;
      }
      line = this.mcu.annotate(line, seq, ts);
      this.receive_stream.push([ts, line_num, line]);

      return [true, null];
    }

    return this.mcu.parse_line(line_num, line); // Delegate to MCU's parsing
  }

  get_lines() {
    return this.receive_stream;
  }
}

const stats_seq_s = ' send_seq=(?<sseq>[0-9]+) receive_seq=(?<rseq>[0-9]+) ';
const serial_dump_r = new RegExp('^Dumping serial stats: .*' + stats_seq_s);
const send_dump_r = new RegExp('^Dumping send queue ' + count_s + ' messages$');
const receive_dump_r = new RegExp('^Dumping receive queue ' + count_s + ' messages$');
const clock_r = new RegExp('^clocksync state: mcu_freq=(?<freq>[0-9]+) .*'
                           + ' clock_est=\\((?<st>[^ ]+)'
                           + ' (?<sc>[0-9]+) (?<f>[^ ]+)\\)');
const repl_seq_r = new RegExp(': seq: 1' + shortseq_s);
const clock_s = '(?<clock>[0-9]+)';
const repl_clock_r = new RegExp('clock=' + clock_s);
const repl_uart_r = new RegExp('tmcuart_(?:response|send) oid=[0-9]+'
                               + ' (?:read|write)=b?(?<msg>(?:\'[^\']*\''
                               + '|"[^"]*"))');

class MCUStream {
  constructor(name) {
    this.name = name;
    this.sent_time_to_seq = {};
    this.sent_seq_to_time = {};
    this.receive_seq_to_time = {};
    this.mcu_freq = 1;
    this.clock_est = [0.0, 0.0, 1.0]; // Using an array for the tuple-like data
    this.shutdown_seq = null;
  }

  trans_clock(clock, ts) {
    const [sample_time, sample_clock, freq] = this.clock_est;

    const exp_clock = parseInt(sample_clock + ((ts - sample_time) * freq), 10);
    const ext_clock = add_high_bits(clock, exp_clock, 0xffffffff);

    return sample_time + ((ext_clock - sample_clock) / freq);
  }

  annotate(line, seq, ts) {
    if (seq !== undefined) {
      line = line.replace(repl_seq_r, (match, p1) =>

        match + '(' + seq + ')' // Replace with the new sequence number and return
      );
    }

    line = line.replace(repl_clock_r, (match, p1) => {
      const clock = parseInt(p1, 10);
      const transClockResult = this.trans_clock(clock, ts).toFixed(6);

      return match.trim() + `(${transClockResult})`;
    });

    line = line.replace(repl_uart_r, (match, msgMatch) => {
      const msgStr = msgMatch.slice(1, -1).trim(); // Remove surrounding quotes

      const bytes = [];
      let i = 0;

      while (i < msgStr.length) {
        if (msgStr[i] === '\\') {
          // Handle escape sequence, e.g. \n\xfa/ \x80\x00\x02\x08\xa0\x89
          if (msgStr[i + 1] === 'x' && /^[0-9a-fA-F]{2}$/.test(msgStr.slice(i + 2, i + 4))) {
            const hex = msgStr.slice(i + 2, i + 4); // Get the hexadecimal value

            bytes.push(parseInt(hex, 16)); // Convert hex to decimal and push to array
            i += 4; // Move to next character after the escape sequence
          } else if (msgStr[i + 1] === 'n') {
            // newline char
            bytes.push(10);
            i += 2; // Move to the next character after backslash
          } else {
            // Not a valid hexadecimal escape sequence, treat as a normal character
            bytes.push(msgStr.charCodeAt(i + 1)); // Push the character after backslash
            i += 2; // Move to the next character after backslash
          }
        } else {
          // Normal character, push its ASCII code
          bytes.push(msgStr.charCodeAt(i));
          i += 1;
        }
      }
      const msgBytes = new Uint8Array(bytes); // Create Uint8Array from byte values

      const parsedMsg = new TMCUartHelper().parse_msg(msgBytes); // Parse the message


      return match.trim() + parsedMsg;
    });


    if (this.name !== 'mcu') {
      line = `mcu '${this.name}': ${line}`;
    }

    return line;
  }

  parse_line(line_num, line) {
    let m = clock_r.exec(line);

    if (m !== null) {
      this.mcu_freq = parseInt(m.groups.freq, 10);
      const st = parseFloat(m.groups.st);
      const sc = parseInt(m.groups.sc, 10);
      const f = parseFloat(m.groups.f);

      this.clock_est = [st, sc, f];
    }

    m = serial_dump_r.exec(line);
    if (m !== null) {
      this.shutdown_seq = parseInt(m.groups.rseq, 10);
    }

    m = send_dump_r.exec(line);
    if (m !== null) {
      return [true, new MCUSentStream(this, parseInt(m.groups.count, 10))];
    }

    m = receive_dump_r.exec(line);
    if (m !== null) {
      return [true, new MCUReceiveStream(this)];
    }

    return [false, null];
  }

  get_lines() {
    return [];
  }
}

const stepper_move_r = new RegExp('^queue_step ' + count_s + ': t=' + clock_s
                                  + ' ');

function splitWithRest(str, delimiter, limit) {
  const parts = str.split(delimiter);
  const rest = parts.slice(limit).join(delimiter);
  const truncatedParts = parts.slice(0, limit);

  truncatedParts.push(rest);

  return truncatedParts;
}

class StepperStream {
  constructor(name, mcu_name, mcus) {
    this.name = name;
    this.stepper_stream = [];
    const mcu = mcus[mcu_name];

    this.clock_est = [0.0, 0.0, 1.0];

    if (mcu !== undefined) {
      this.clock_est = mcu.clock_est;
    }
  }

  parse_line(line_num, line) {
    const m = stepper_move_r.exec(line);


    if (m !== null) {
      const clock = parseInt(m.groups.clock, 10);
      const [sample_time, sample_clock, freq] = this.clock_est;
      const ts = sample_time + ((clock - sample_clock) / freq);


      const parts = splitWithRest(line, ' ', 4);


      parts[0] = `${this.name} queue_step`;
      parts[2] += `(${ts.toFixed(6)})`;
      this.stepper_stream.push([ts, line_num, parts.join(' ')]);

      return [true, null];
    }

    return [false, null];
  }

  get_lines() {
    return this.stepper_stream;
  }
}

const trapq_move_r = new RegExp('^move ' + count_s + ': pt=' + time_s);

class TrapQStream {
  constructor(name, mcus) {
    this.name = name;
    this.trapq_stream = [];
    this.mcu_freq = 1;
    this.clock_est = [0.0, 0.0, 1.0];

    // Check if 'mcu' exists in mcus, and if so, set properties accordingly
    if ('mcu' in mcus) {
      const mcu = mcus['mcu'];


      this.mcu_freq = mcu.mcu_freq;
      this.clock_est = mcu.clock_est;
    }
  }

  parse_line(line_num, line) {
    const m = trapq_move_r.exec(line);

    if (m !== null) {
      const pt = parseFloat(m.groups.time);

      const clock = pt * this.mcu_freq;
      const [sample_time, sample_clock, freq] = this.clock_est;

      const ts = sample_time + ((clock - sample_clock) / freq);

      const parts = splitWithRest(line, ' ', 4);

      parts[0] = `${this.name} move`;
      parts[2] += `(${ts.toFixed(6)})`;
      this.trapq_stream.push([ts, line_num, parts.join(' ')]);

      return [true, null];
    }

    return [false, null];
  }

  get_lines() {
    return this.trapq_stream;
  }
}


const gcode_cmd_r = new RegExp('^Read (?<time>[0-9.]+): (?<gcode>["\'].*)$');
const varlist_split_r = /(\w+)=(\[.*?\]|\S+)/g;

class GCodeStream {
  constructor(shutdown_line_num, logname) {
    this.gcode_stream = [];
    this.gcode_commands = [];
    this.gcode_state = '';
    this.gcode_filename = `${logname}.gcode${shutdown_line_num.toString().padStart(5, '0')}`;
  }

  extract_params(line) {
    const result = {};
    let match;

    while ((match = varlist_split_r.exec(line)) !== null) {
      const key = match[1];
      const valueStr = match[2];

      // Try to parse the value as JSON, number, or boolean
      try {
        result[key] = JSON.parse(valueStr);
      } catch (error) {
        // If it fails, try parsing as a number or boolean
        if (valueStr === 'True' || valueStr === 'true') {
          result[key] = true;
        } else if (valueStr === 'False' || valueStr === 'false') {
          result[key] = false;
        } else if (!isNaN(valueStr)) {
          result[key] = parseFloat(valueStr);
        } else if (valueStr.startsWith('[') && valueStr.endsWith(']')) {
          // Handle nested arrays
          result[key] = valueStr.slice(1, -1).split(',')
            .map(parseFloat);
        } else {
          result[key] = valueStr; // Keep as a string
        }
      }
    }

    return result;
  }

  handle_gcode_state(line) {
    const kv = this.extract_params(line);
    const out = ['; Start g-code state restore', 'G28'];

    if (!kv['absolute_coord'] && !kv['absolutecoord']) {
      out.push('G91');
    }
    if (!kv['absolute_extrude'] && !kv['absoluteextrude']) {
      out.push('M83');
    }

    const lp = kv['last_position'] || [0, 0, 0, 0];
    const bp = kv['base_position'] || [0, 0, 0, 0];
    const hp = kv['homing_position'] || [0, 0, 0, 0];

    if (lp.length === 4 && bp.length === 4 && hp.length === 4) {
      out.push(`G1 X${lp[0]} Y${lp[1]} Z${lp[2]} F${(kv['speed'] || 0) * 60}`);
      if (bp[0] !== 0 || bp[1] !== 0 || bp[2] !== 0) {
        out.push('; Must manually set base position...');
      }
      out.push(`G92 E${lp[3] - bp[3]}`);
      if (hp[0] !== 0 || hp[1] !== 0 || hp[2] !== 0 || hp[3] !== 0) {
        out.push('; Must manually set homing position...');
      }
      if (Math.abs((kv['speed_factor'] || 0) - 1 / 60) > 0.000001) {
        out.push(`M220 S${(kv['speed_factor'] || 0) * 60 * 100}`);
      }
      if ((kv['extrude_factor'] || 1) !== 1) {
        out.push(`M221 S${(kv['extrude_factor'] || 1) * 100}`);
      }
    }

    out.push('; End of state restore', '', '');
    this.gcode_state = out.join('\n');
  }

  parse_line(line_num, line) {
    const m = gcode_cmd_r.exec(line);

    if (m !== null) {
      const ts = parseFloat(m.groups.time);

      this.gcode_stream.push([ts, line_num, line]);
      // Remove the quotes and escape sequences from the G-code command
      const gcode = m.groups.gcode.slice(1, -1).replace(/\\n/g, '');

      this.gcode_commands.push(gcode);
      
      return [true, null];
    }

    return [false, null];
  }

  get_lines() {
    if (this.gcode_stream.length > 0) {
      const data = this.gcode_commands.join('\n');
      const gcodeContent = this.gcode_state + '\n' + data;
	  
      displayManager.collectGcode(this.gcode_filename, gcodeContent);
    }

    return this.gcode_stream;
  }
}


const api_cmd_r = new RegExp('^Received ' + time_s + ': \\{.*\\}$');

class APIStream {
  constructor() {
    this.api_stream = [];
  }

  parse_line(line_num, line) {
    const m = api_cmd_r.exec(line);

    if (m !== null) {
      const ts = parseFloat(m.groups.time);

      this.api_stream.push([ts, line_num, line]);

      return [true, null];
    }

    return [false, null];
  }

  get_lines() {
    return this.api_stream;
  }
}

const stats_r = new RegExp('^Stats ' + time_s + ': ');
const mcu_r = new RegExp('^MCU \'(?<mcu>.+?)\' (is_)?shutdown: (?<reason>.*)$');
const stepper_r = new RegExp('^Dumping stepper \'(?<name>[^\']*)\' \\((?<mcu>[^)]+)\\) '
                            + count_s + ' queue_step:$');
const trapq_r = new RegExp('^Dumping trapq \'(?<name>[^\']*)\' ' + count_s
                          + ' moves:$');
const gcode_r = new RegExp('Dumping gcode input ' + count_s + ' blocks$');
const gcode_state_r = new RegExp('^gcode state: ');
const api_r = new RegExp('Dumping ' + count_s + ' requests for client (?<client>[0-9]+)$');


class StatsStream {
  constructor(shutdown_line_num, logname) {
    this.shutdown_line_num = shutdown_line_num;
    this.gcode_stream = new GCodeStream(shutdown_line_num, logname);
    this.mcus = {};
    this.first_stat_time = null;
    this.last_stat_time = null;
    this.stats_stream = [];
  }

  reset_first_stat_time() {
    this.first_stat_time = this.last_stat_time;
  }

  get_stat_times() {
    return [this.first_stat_time, this.last_stat_time];
  }

  check_stats_seq(ts, line) {
    // 1. Parse stats
    const parts = line.split();
    let mcu = '';
    const keyparts = {};

    for (let i = 2; i < parts.length; i++) {
      if (parts[i].indexOf('=') === -1) {
        mcu = parts[i];
      } else {
        const [name, val] = parts[i].split('=', 1);

        keyparts[mcu + name] = val;
      }
    }

    // 2. Adjust timestamp based on MCU data
    let min_ts = 0;
    let max_ts = 999999999999;

    for (const [mcu_name, mcu2] of Object.entries(this.mcus)) {
      const sname = `${mcu_name}:send_seq`;

      const rname = `${mcu_name}:receive_seq`;


      if (!(sname in keyparts)) {
        continue;
      }

      const sseq = parseInt(keyparts[sname], 10);

      const rseq = parseInt(keyparts[rname], 10);

      min_ts = Math.max(min_ts, mcu.sent_seq_to_time.get(sseq - 1, 0), mcu.receive_seq_to_time.get(rseq, 0));
      max_ts = Math.min(max_ts, mcu.sent_seq_to_time.get(sseq, 999999999999), mcu.receive_seq_to_time.get(rseq + 1, 999999999999));
    }

    // 3. Return adjusted timestamp
    return Math.min(Math.max(ts, min_ts + 0.00000001), max_ts - 0.00000001);
  }


  parse_line(line_num, line) {
    if (stats_r.test(line)) {
      const match = line.match(stats_r);
      const ts = parseFloat(match.groups.time);

      this.last_stat_time = ts;
      if (this.first_stat_time === null) {
        this.first_stat_time = ts;
      }
      this.stats_stream.push([ts, line_num, line]);

      return [true, null];
    }

    // Handle default
    this.stats_stream.push([null, line_num, line]);

    if (mcu_r.test(line)) {
      const match = line.match(mcu_r);

      const mcu_name = match.groups.mcu;

      const mcu_stream = new MCUStream(mcu_name);


      this.mcus[mcu_name] = mcu_stream;

      return [true, mcu_stream];
    }
    if (stepper_r.test(line)) {
      const match = line.match(stepper_r);
      const name = match.groups.name;
      const mcu = match.groups.mcu;


      const stepper_stream = new StepperStream(name, mcu, this.mcus);


      return [true, stepper_stream];
    }
    if (trapq_r.test(line)) {
      const match = line.match(trapq_r);
      const name = match.groups.name;

      const trapq_stream = new TrapQStream(name, this.mcus);


      return [true, trapq_stream];
    }
    if (gcode_r.test(line)) {
      return [true, this.gcode_stream];
    }

    if (gcode_state_r.test(line)) {
      this.gcode_stream.handle_gcode_state(line);

      return [true, null];
    }
    if (api_r.test(line)) {
      const match = line.match(api_r);
      const client = match.groups.client;
      const api_stream = new APIStream(client);


      return [true, api_stream];
    }

    return [false, null];
  }

  get_lines() {
    const all_ts = [];

    for (const [mcu_name, mcu] of Object.entries(this.mcus)) {
      all_ts.push(...Object.values(mcu.sent_seq_to_time));
      all_ts.push(...Object.values(mcu.receive_seq_to_time));
    }

    if (!all_ts.length) {
      return [];
    }

    const min_stream_ts = Math.min(...all_ts);
    const max_stream_ts = Math.max(...all_ts);

    for (let i = 0; i < this.stats_stream.length; i++) {
      const [ts, line_num, line] = this.stats_stream[i];

      if (ts !== null && ts >= min_stream_ts - 5) {
        this.stats_stream.splice(0, i);
        break;
      }
    }

    let last_ts = min_stream_ts;

    for (let i = 0; i < this.stats_stream.length; i++) {
      const [ts, line_num, line] = this.stats_stream[i];

      if (ts !== null) {
        last_ts = this.check_stats_seq(ts, line);
      } else if (line_num >= this.shutdown_line_num && last_ts <= max_stream_ts) {
        last_ts = max_stream_ts + 0.00000001;
      }
      this.stats_stream[i] = [last_ts, line_num, line];
    }

    return this.stats_stream;
  }
}


class GatherShutdown {
  constructor(configs, line_num, recent_lines, logname) {
    this.filename = `${logname}.shutdown${line_num.toString().padStart(5, '0')}`;
    this.comments = [];
    if (configs) {
      const configsById = {};

      for (const c of Object.values(configs)) {
        configsById[c.config_num] = c;
      }
      const config = configsById[Math.max(...Object.keys(configsById))];

      config.add_comment(format_comment(line_num, recent_lines[recent_lines.length - 1][1]));
      this.comments.push(`# config ${config.filename}`);
    }

    this.stats_stream = new StatsStream(line_num, logname);
    this.active_streams = [this.stats_stream];
    this.all_streams = [...this.active_streams]; // Copy the array

    for (const [line_num2, line] of recent_lines) {
      this.parse_line(line_num2, line);
    }
    this.stats_stream.reset_first_stat_time();
  }

  add_comment(comment) {
    if (comment !== null) {
      this.comments.push(comment);
    }
  }

  add_line(line_num, line) {
    this.parse_line(line_num, line);
    const [firstStatTime, lastStatTime] = this.stats_stream.get_stat_times();

    if (firstStatTime !== null && lastStatTime > firstStatTime + 5) {
      this.finalize();

      return false; // Stop further processing
    }

    const startConditions = [
      line.startsWith('Git version'),
      line.startsWith('Start printer at'),
      line === '===== Config file ====='
    ];

    if (startConditions.some((cond) => cond)) {
      this.finalize();

      return false; // Stop further processing
    }

    return true;
  }

  parse_line(line_num, line) {
    for (const s of this.active_streams) {
      const [did_parse, new_stream] = s.parse_line(line_num, line);


      if (did_parse) {
        if (new_stream !== null) {
          this.all_streams.push(new_stream);
          this.active_streams = [new_stream, this.stats_stream];
        }
        break;
      }
    }
  }

  finalize() {
    const streams = this.all_streams.map((p) => p.get_lines());

    for (const s of streams) {
      for (let i = 1; i < s.length; i++) {
        if (s[i - 1][0] > s[i][0]) {
          s[i] = [s[i - 1][0], s[i][1], s[i][2]];
        }
      }
    }

    const out = streams.flat();

    out.sort((a, b) => a[0] - b[0]);

    const lines = [
      ...this.comments,
      ...out.map((i) => i[2])
    ];
    const content = lines.join('\n');
	
    displayManager.collectShutdown(this.filename, content);
  }
}

const displayManager = new DisplayManager();

function processLogFile(file, filename) {
  let last_git = null;
  let last_start = null;
  const configs = {};
  let handler = null;
  const recent_lines = [];

  const reader = new FileReader();

  reader.onload = function(event) {
    const logFileContent = event.target.result;
    const lines = logFileContent.split('\n');

    for (let [line_num, line] of lines.entries()) {
      line = line.trim();
      line_num += 1;
      recent_lines.push([line_num, line]);

      if (handler !== null) {
        const ret = handler.add_line(line_num, line);

        if (ret) {
          continue;
        }
        recent_lines.length = 0; // Clear recent_lines
        handler = null;
      }

      if (line.startsWith('Git version')) {
        last_git = format_comment(line_num, line);
      } else if (line.startsWith('Start printer at')) {
        last_start = format_comment(line_num, line);
      } else if (line === '===== Config file =====') {
        handler = new GatherConfig(configs, line_num, recent_lines, filename); // Store the instance
        handler.add_comment(last_git);
        handler.add_comment(last_start);
      } else if (line.includes('shutdown: ') || line.startsWith('Dumping ')) {
        handler = new GatherShutdown(configs, line_num, recent_lines, filename); // Store the instance
        handler.add_comment(last_git);
        handler.add_comment(last_start);
      }
    }
    if (handler !== null) {
      handler.finalize();
    }
    for (const config of Object.values(configs)) {
      config.write_file();
    }
    displayManager.show();
  };
  reader.readAsText(file);
}
