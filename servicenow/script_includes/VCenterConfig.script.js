/**
 * Script Include: VCenterConfig
 * Scope: x_ftl_vcenter_etl
 *
 * Centralised configuration reader backed by sys_properties.
 * All properties are namespaced under x_ftl_vcenter_etl.*
 *
 * Required sys_properties (set during install):
 *   x_ftl_vcenter_etl.connection_alias   - Name of Connection & Credential Alias
 *   x_ftl_vcenter_etl.mid_server         - MID Server name for FT1 domain
 *   x_ftl_vcenter_etl.vcenter_host       - vCenter FQDN / IP
 *   x_ftl_vcenter_etl.log_level          - DEBUG | INFO | WARN | ERROR (default INFO)
 *   x_ftl_vcenter_etl.page_size          - API page size (default 200)
 *   x_ftl_vcenter_etl.max_retries        - HTTP retry limit (default 3)
 *   x_ftl_vcenter_etl.timeout_ms         - HTTP timeout ms (default 30000)
 *   x_ftl_vcenter_etl.staleness_days     - Days before CI marked stale (default 7)
 *   x_ftl_vcenter_etl.discovery_source   - Discovery source (default vCenterETL)
 *   x_ftl_vcenter_etl.batch_size         - IRE batch size (default 50)
 *   x_ftl_vcenter_etl.incremental        - true | false enable incremental (default false)
 *   x_ftl_vcenter_etl.notify_email       - Failure notification email
 */
var VCenterConfig = Class.create();
VCenterConfig.prototype = {

    initialize: function() {
        this._cache = {};
    },

    /** Get a string property with optional default. */
    get: function(key, defaultVal) {
        var fullKey = 'x_ftl_vcenter_etl.' + key;
        if (this._cache[fullKey] !== undefined) {
            return this._cache[fullKey];
        }
        var val = gs.getProperty(fullKey, defaultVal !== undefined ? defaultVal : '');
        this._cache[fullKey] = val;
        return val;
    },

    /** Get a boolean property. */
    getBool: function(key, defaultVal) {
        var val = this.get(key, defaultVal ? 'true' : 'false');
        return val === 'true' || val === '1';
    },

    /** Get an integer property. */
    getInt: function(key, defaultVal) {
        var val = parseInt(this.get(key, String(defaultVal || 0)));
        return isNaN(val) ? (defaultVal || 0) : val;
    },

    // ─── Named accessors ────────────────────────────────────────────────────

    connectionAlias:   function() { return this.get('connection_alias', 'x_ftl_vcenter_etl.vcenter_conn'); },
    midServer:         function() { return this.get('mid_server', ''); },
    vcenterHost:       function() { return this.get('vcenter_host', ''); },
    logLevel:          function() { return this.get('log_level', 'INFO'); },
    pageSize:          function() { return this.getInt('page_size', 200); },
    maxRetries:        function() { return this.getInt('max_retries', 3); },
    timeoutMs:         function() { return this.getInt('timeout_ms', 30000); },
    stalenessDays:     function() { return this.getInt('staleness_days', 7); },
    discoverySource:   function() { return this.get('discovery_source', 'vCenterETL'); },
    batchSize:         function() { return this.getInt('batch_size', 50); },
    incremental:       function() { return this.getBool('incremental', false); },
    notifyEmail:       function() { return this.get('notify_email', ''); },

    /**
     * Return the required property list for installation validation.
     */
    getRequiredProperties: function() {
        return [
            'x_ftl_vcenter_etl.connection_alias',
            'x_ftl_vcenter_etl.mid_server',
            'x_ftl_vcenter_etl.vcenter_host'
        ];
    },

    /**
     * Validate required properties are set; return array of missing keys.
     */
    validate: function() {
        var missing = [];
        var required = this.getRequiredProperties();
        for (var i = 0; i < required.length; i++) {
            var val = gs.getProperty(required[i], '');
            if (!val || val.trim() === '') {
                missing.push(required[i]);
            }
        }
        return missing;
    },

    type: 'VCenterConfig'
};
