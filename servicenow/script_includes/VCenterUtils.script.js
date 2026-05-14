/**
 * Script Include: VCenterUtils
 * Scope: x_ftl_vcenter_etl
 *
 * Shared utility helpers for the vCenter ETL integration.
 */
var VCenterUtils = Class.create();
VCenterUtils.prototype = {

    initialize: function() {},

    /**
     * Generate a unique run ID: YYYYMMDD-HHmmss-<random4>.
     */
    generateRunId: function() {
        var now = new GlideDateTime();
        var dt  = now.getValue().replace(/[^0-9]/g, '').substring(0, 14);
        var rnd = Math.floor(Math.random() * 9999).toString().padStart(4, '0');
        return dt + '-' + rnd;
    },

    /**
     * Safe JSON parse — returns null on failure.
     */
    parseJSON: function(str) {
        try {
            return JSON.parse(str);
        } catch (e) {
            return null;
        }
    },

    /**
     * Safe JSON stringify — returns '' on failure.
     */
    toJSON: function(obj) {
        try {
            return JSON.stringify(obj);
        } catch (e) {
            return '';
        }
    },

    /**
     * Truncate a string to maxLen characters.
     */
    truncate: function(str, maxLen) {
        if (!str) return '';
        str = String(str);
        return str.length > maxLen ? str.substring(0, maxLen) : str;
    },

    /**
     * Convert bytes to GB, rounded to 2 decimal places.
     */
    bytesToGB: function(bytes) {
        if (!bytes || isNaN(bytes)) return 0;
        return Math.round((bytes / (1024 * 1024 * 1024)) * 100) / 100;
    },

    /**
     * Convert MB to GB.
     */
    mbToGB: function(mb) {
        if (!mb || isNaN(mb)) return 0;
        return Math.round((mb / 1024) * 100) / 100;
    },

    /**
     * Return the current timestamp as a GlideDateTime string.
     */
    now: function() {
        return new GlideDateTime().getValue();
    },

    /**
     * Look up a sys_id from a given table by field=value.
     * Returns '' if not found.
     */
    getSysId: function(table, field, value) {
        if (!value) return '';
        var gr = new GlideRecord(table);
        gr.addQuery(field, value);
        gr.setLimit(1);
        gr.query();
        return gr.next() ? gr.getUniqueValue() : '';
    },

    /**
     * Check if a value is null, undefined, or empty string.
     */
    isEmpty: function(val) {
        return val === null || val === undefined || String(val).trim() === '';
    },

    /**
     * Safely get a nested property from an object using dot notation.
     * e.g. get(obj, 'a.b.c')
     */
    get: function(obj, path) {
        if (!obj || !path) return null;
        return path.split('.').reduce(function(acc, key) {
            return acc && acc[key] !== undefined ? acc[key] : null;
        }, obj);
    },

    /**
     * Map vCenter power state to ServiceNow operational status.
     * Returns integer:
     *   1 = Operational
     *   2 = Non-Operational
     *   6 = Retired
     */
    mapPowerState: function(vcPowerState) {
        var map = {
            'POWERED_ON':  '1',
            'POWERED_OFF': '2',
            'SUSPENDED':   '2',
            'poweredOn':   '1',
            'poweredOff':  '2',
            'suspended':   '2'
        };
        return map[vcPowerState] || '2';
    },

    /**
     * Map vCenter connection state to ServiceNow install_status.
     * 1 = Installed, 2 = Absent
     */
    mapConnectionState: function(connState) {
        return (connState === 'CONNECTED' || connState === 'connected') ? '1' : '2';
    },

    /**
     * Return the discovery source constant for this integration.
     */
    getDiscoverySource: function() {
        return 'vCenterETL';
    },

    /**
     * Return the ETL company scope prefix.
     */
    getScope: function() {
        return 'x_ftl_vcenter_etl';
    },

    type: 'VCenterUtils'
};
