/**
 * Script Include: VCenterAPIClient
 * Scope: x_ftl_vcenter_etl
 *
 * REST client for VMware vCenter REST API (v7/v8).
 * All HTTP calls are routed through the configured MID Server via a
 * Connection & Credential Alias, supporting both Basic Auth and
 * VMware session-token (Bearer) authentication.
 *
 * vCenter REST API base:  https://<vcenter>/api
 *
 * Lifecycle:
 *   var client = new VCenterAPIClient(runId);
 *   client.connect();           // authenticate → obtain session token
 *   var vms = client.getVMs();  // paginated fetch
 *   client.disconnect();        // DELETE /api/session
 */
var VCenterAPIClient = Class.create();
VCenterAPIClient.prototype = {

    initialize: function(runId) {
        this.cfg          = new VCenterConfig();
        this.logger       = new VCenterLogger('VCenterAPIClient', runId);
        this.retry        = new VCenterRetryHandler();
        this.utils        = new VCenterUtils();
        this.sessionToken = '';
        this.connected    = false;
        this.runId        = runId || '';
    },

    // ─── Authentication ──────────────────────────────────────────────────────

    /**
     * Authenticate against vCenter and store session token.
     * Returns true on success.
     */
    connect: function() {
        this.logger.info('Authenticating to vCenter via connection alias: ' +
            this.cfg.connectionAlias());

        var self = this;
        var resp = this.retry.execute(function() {
            return self._request('POST', '/api/session', null, null, true);
        }, this.cfg.maxRetries(), 2000);

        if (!resp || resp.status !== 201) {
            this.logger.error('Authentication failed. Status: ' +
                (resp ? resp.status : 'null') + ' Body: ' +
                (resp ? resp.body : 'null'));
            return false;
        }

        this.sessionToken = resp.body ? resp.body.replace(/"/g, '') : '';
        this.connected    = true;
        this.logger.info('Authenticated. Session token obtained.');
        return true;
    },

    /**
     * Invalidate the vCenter session.
     */
    disconnect: function() {
        if (!this.connected || !this.sessionToken) return;
        this._request('DELETE', '/api/session', null, null, false);
        this.sessionToken = '';
        this.connected    = false;
        this.logger.info('Session terminated.');
    },

    // ─── vCenter Object Fetchers ─────────────────────────────────────────────

    /** Fetch all vCenter instances (top-level object). */
    getVCenterInfo: function() {
        var resp = this._request('GET', '/api/vcenter/system/version', null, null, false);
        if (!resp || resp.status !== 200) return null;
        return this.utils.parseJSON(resp.body);
    },

    /** Fetch all Datacenters. */
    getDatacenters: function() {
        return this._getPaginated('/api/vcenter/datacenter', {});
    },

    /** Fetch all Clusters. Optional datacenter filter. */
    getClusters: function(datacenterMoRef) {
        var params = {};
        if (datacenterMoRef) params['filter.datacenters'] = datacenterMoRef;
        return this._getPaginated('/api/vcenter/cluster', params);
    },

    /** Fetch all ESXi Hosts. Optional cluster/datacenter filter. */
    getHosts: function(clusterMoRef, datacenterMoRef) {
        var params = {};
        if (clusterMoRef)    params['filter.clusters']    = clusterMoRef;
        if (datacenterMoRef) params['filter.datacenters'] = datacenterMoRef;
        return this._getPaginated('/api/vcenter/host', params);
    },

    /** Fetch detail for a single ESXi host. */
    getHostDetail: function(hostId) {
        var resp = this._request('GET', '/api/vcenter/host/' + hostId, null, null, false);
        if (!resp || resp.status !== 200) return null;
        return this.utils.parseJSON(resp.body);
    },

    /** Fetch all VMs. Optional filter params. */
    getVMs: function(filter) {
        return this._getPaginated('/api/vcenter/vm', filter || {});
    },

    /** Fetch detail for a single VM (hardware, guest OS, etc.). */
    getVMDetail: function(vmId) {
        var resp = this._request('GET', '/api/vcenter/vm/' + vmId, null, null, false);
        if (!resp || resp.status !== 200) return null;
        return this.utils.parseJSON(resp.body);
    },

    /** Fetch all Datastores. */
    getDatastores: function() {
        return this._getPaginated('/api/vcenter/datastore', {});
    },

    /** Fetch all Datastore Clusters (storage pods). */
    getDatastoreClusters: function() {
        return this._getPaginated('/api/vcenter/storage/policies', {});
    },

    /** Fetch all Distributed Virtual Switches. */
    getDistributedSwitches: function() {
        return this._getPaginated('/api/vcenter/network',
            {'filter.types': 'DISTRIBUTED_PORTGROUP'});
    },

    /** Fetch all networks (returns DVS + standard portgroups). */
    getNetworks: function() {
        return this._getPaginated('/api/vcenter/network', {});
    },

    // ─── Pagination ──────────────────────────────────────────────────────────

    /**
     * Transparently paginate a GET endpoint.
     * vCenter REST API uses cursor-based pagination via the vmware-api-session-id
     * and a Link: <next> header, or falls back to offset/limit params.
     */
    _getPaginated: function(path, params) {
        var allItems  = [];
        var pageSize  = this.cfg.pageSize();
        var offset    = 0;
        var hasMore   = true;
        var pageNum   = 0;

        while (hasMore) {
            pageNum++;
            var reqParams = {};
            for (var k in params) {
                if (params.hasOwnProperty(k)) reqParams[k] = params[k];
            }
            reqParams['filter.limit']  = pageSize;
            reqParams['filter.offset'] = offset;

            var self = this;
            var resp = this.retry.execute(function() {
                return self._request('GET', path, reqParams, null, false);
            }, this.cfg.maxRetries(), 2000);

            if (!resp || resp.status !== 200) {
                this.logger.error('Paginated fetch failed on page ' + pageNum +
                    ' for ' + path + '. Status: ' + (resp ? resp.status : 'null'));
                break;
            }

            var body  = this.utils.parseJSON(resp.body);
            var items = Array.isArray(body) ? body : (body && body.value ? body.value : []);

            if (!items || items.length === 0) {
                hasMore = false;
                break;
            }

            allItems = allItems.concat(items);
            this.logger.debug('Page ' + pageNum + ': fetched ' + items.length +
                ' items from ' + path + ' (total so far: ' + allItems.length + ')');

            if (items.length < pageSize) {
                hasMore = false;
            } else {
                offset += pageSize;
            }

            // Safety guard: max 500 pages
            if (pageNum >= 500) {
                this.logger.warn('Page limit (500) reached for ' + path);
                break;
            }
        }

        this.logger.info('Fetched ' + allItems.length + ' total items from ' + path);
        return allItems;
    },

    // ─── HTTP Request ────────────────────────────────────────────────────────

    /**
     * Execute a single HTTP request via MID Server / Connection Alias.
     *
     * @param {string}  method   - HTTP method
     * @param {string}  path     - API path (appended to connection alias base URL)
     * @param {object}  params   - Query params
     * @param {object}  body     - Request body (will be JSON-serialised)
     * @param {boolean} isAuth   - If true use Basic Auth header; else use session token
     * @returns {{ status, body, headers }} | null on exception
     */
    _request: function(method, path, params, body, isAuth) {
        try {
            var sm = new sn_ws.RESTMessageV2();
            sm.setHttpMethod(method);
            sm.setConnectionAlias(this.cfg.connectionAlias());
            sm.setHttpTimeout(this.cfg.timeoutMs());

            // Build URL with query params
            var qs = '';
            if (params) {
                var parts = [];
                for (var key in params) {
                    if (params.hasOwnProperty(key)) {
                        parts.push(encodeURIComponent(key) + '=' +
                            encodeURIComponent(params[key]));
                    }
                }
                if (parts.length) qs = '?' + parts.join('&');
            }
            sm.setEndpoint(path + qs);

            // Auth headers
            if (isAuth) {
                // Basic auth is handled by the Connection & Credential Alias
                // but we still set Accept header
            } else if (this.sessionToken) {
                sm.setRequestHeader('vmware-api-session-id', this.sessionToken);
            }
            sm.setRequestHeader('Accept',       'application/json');
            sm.setRequestHeader('Content-Type', 'application/json');

            if (body) {
                sm.setRequestBody(JSON.stringify(body));
            }

            var response = sm.execute();
            var status   = parseInt(response.getStatusCode());
            var respBody = response.getBody();

            this.logger.debug(method + ' ' + path + ' → ' + status);

            return {
                status:  status,
                body:    respBody,
                headers: response.getHeaders()
            };

        } catch (e) {
            this.logger.error('HTTP exception on ' + method + ' ' + path + ': ' + e.message);
            return null;
        }
    },

    type: 'VCenterAPIClient'
};
