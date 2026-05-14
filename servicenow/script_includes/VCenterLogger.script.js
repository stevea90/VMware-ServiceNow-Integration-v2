/**
 * Script Include: VCenterLogger
 * Scope: x_ftl_vcenter_etl
 *
 * Centralised logging for the vCenter ETL integration.
 * Writes to x_ftl_vcenter_etl_log and gs.log().
 * Levels: DEBUG | INFO | WARN | ERROR
 */
var VCenterLogger = Class.create();
VCenterLogger.prototype = {

    /**
     * @param {string} source   - Caller name, e.g. 'VCenterAPIClient'
     * @param {string} runId    - Optional ETL run correlation ID
     */
    initialize: function(source, runId) {
        this.source  = source  || 'VCenterETL';
        this.runId   = runId   || '';
        this._level  = this._resolveLevel();
        this._LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
    },

    debug: function(msg, detail) { this._write('DEBUG', msg, detail); },
    info:  function(msg, detail) { this._write('INFO',  msg, detail); },
    warn:  function(msg, detail) { this._write('WARN',  msg, detail); },
    error: function(msg, detail) { this._write('ERROR', msg, detail); },

    /** Write one log entry to the custom table and gs.log/gs.error */
    _write: function(level, msg, detail) {
        if (this._LEVELS[level] < this._LEVELS[this._level]) {
            return;
        }

        var fullMsg = '[' + this.source + '] ' + msg;

        if (level === 'ERROR') {
            gs.error(fullMsg);
        } else if (level === 'WARN') {
            gs.warn(fullMsg);
        } else {
            gs.log(fullMsg);
        }

        try {
            var log = new GlideRecord('x_ftl_vcenter_etl_log');
            log.initialize();
            log.setValue('level',   level);
            log.setValue('source',  this.source);
            log.setValue('run_id',  this.runId);
            log.setValue('message', msg);
            log.setValue('detail',  detail ? JSON.stringify(detail).substring(0, 4000) : '');
            log.insert();
        } catch (e) {
            gs.error('[VCenterLogger] Failed to persist log entry: ' + e.message);
        }
    },

    /** Resolve minimum log level from system property */
    _resolveLevel: function() {
        var prop = gs.getProperty('x_ftl_vcenter_etl.log_level', 'INFO');
        var valid = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
        return valid.indexOf(prop.toUpperCase()) >= 0 ? prop.toUpperCase() : 'INFO';
    },

    type: 'VCenterLogger'
};
