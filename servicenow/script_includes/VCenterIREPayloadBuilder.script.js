/**
 * Script Include: VCenterIREPayloadBuilder
 * Scope: x_ftl_vcenter_etl
 *
 * Builds Identification & Reconciliation Engine (IRE) payloads for each
 * vCenter CI type and submits them via sn_ire.IdentificationEngine.
 *
 * IRE Payload Structure (CSDM-aligned):
 * {
 *   "items": [{
 *     "className":  "cmdb_ci_esx_server",
 *     "values":     { field: value, ... },
 *     "lookupTable": "cmdb_ci_esx_server",
 *     "lookupField": "correlation_id"    // primary identifier
 *   }],
 *   "relations": [{
 *     "parent":  { "className": "...", "values": { ... } },
 *     "child":   { "className": "...", "values": { ... } },
 *     "type":    "Contains::Contained by"
 *   }]
 * }
 *
 * Discovery source: vCenterETL (set on every payload).
 */
var VCenterIREPayloadBuilder = Class.create();
VCenterIREPayloadBuilder.prototype = {

    initialize: function(runId) {
        this.runId  = runId || '';
        this.logger = new VCenterLogger('VCenterIREPayloadBuilder', runId);
        this.utils  = new VCenterUtils();
        this.cfg    = new VCenterConfig();
        this.source = this.cfg.discoverySource();
    },

    // ─── Payload Builders ────────────────────────────────────────────────────

    buildVCenterPayload: function(stgGr) {
        return {
            className: 'cmdb_ci_vcenter',
            values: {
                name:             stgGr.getValue('name'),
                correlation_id:   stgGr.getValue('moref'),
                ip_address:       stgGr.getValue('vcenter_fqdn'),
                fqdn:             stgGr.getValue('vcenter_fqdn'),
                version:          stgGr.getValue('version'),
                u_build:          stgGr.getValue('build'),
                u_instance_uuid:  stgGr.getValue('instance_uuid'),
                discovery_source: this.source,
                install_status:   '1',
                operational_status: '1'
            },
            identifiers: [
                { className: 'cmdb_ci_vcenter', field: 'u_instance_uuid', value: stgGr.getValue('instance_uuid') },
                { className: 'cmdb_ci_vcenter', field: 'name',            value: stgGr.getValue('name') }
            ]
        };
    },

    buildDatacenterPayload: function(stgGr) {
        return {
            className: 'cmdb_ci_datacenter',
            values: {
                name:             stgGr.getValue('name'),
                correlation_id:   stgGr.getValue('moref'),
                u_moref:          stgGr.getValue('moref'),
                discovery_source: this.source,
                install_status:   '1',
                operational_status: '1'
            },
            identifiers: [
                { className: 'cmdb_ci_datacenter', field: 'correlation_id', value: stgGr.getValue('moref') },
                { className: 'cmdb_ci_datacenter', field: 'name',           value: stgGr.getValue('name') }
            ]
        };
    },

    buildClusterPayload: function(stgGr) {
        return {
            className: 'cmdb_ci_cluster',
            values: {
                name:             stgGr.getValue('name'),
                correlation_id:   stgGr.getValue('moref'),
                u_moref:          stgGr.getValue('moref'),
                u_ha_enabled:     stgGr.getValue('ha_enabled'),
                u_drs_enabled:    stgGr.getValue('drs_enabled'),
                discovery_source: this.source,
                install_status:   '1',
                operational_status: '1'
            },
            identifiers: [
                { className: 'cmdb_ci_cluster', field: 'correlation_id', value: stgGr.getValue('moref') },
                { className: 'cmdb_ci_cluster', field: 'name',           value: stgGr.getValue('name') }
            ]
        };
    },

    buildHostPayload: function(stgGr) {
        var powerState = this.utils.mapPowerState(stgGr.getValue('power_state'));
        var connState  = this.utils.mapConnectionState(stgGr.getValue('connection_state'));
        return {
            className: 'cmdb_ci_esx_server',
            values: {
                name:             stgGr.getValue('name'),
                correlation_id:   stgGr.getValue('moref'),
                u_moref:          stgGr.getValue('moref'),
                u_bios_uuid:      stgGr.getValue('bios_uuid'),
                cpu_count:        stgGr.getValue('cpu_count'),
                cpu_core_count:   stgGr.getValue('cpu_cores'),
                ram:              String(parseFloat(stgGr.getValue('memory_size_gb') || 0) * 1024),
                model_id:         stgGr.getValue('model'),
                manufacturer:     stgGr.getValue('vendor'),
                os:               stgGr.getValue('os_type'),
                operational_status: powerState,
                install_status:   connState,
                discovery_source: this.source
            },
            identifiers: [
                { className: 'cmdb_ci_esx_server', field: 'u_bios_uuid',    value: stgGr.getValue('bios_uuid') },
                { className: 'cmdb_ci_esx_server', field: 'correlation_id', value: stgGr.getValue('moref') },
                { className: 'cmdb_ci_esx_server', field: 'name',           value: stgGr.getValue('name') }
            ]
        };
    },

    buildVMPayload: function(stgGr) {
        var powerState = this.utils.mapPowerState(stgGr.getValue('power_state'));
        return {
            className: 'cmdb_ci_vmware_instance',
            values: {
                name:             stgGr.getValue('name'),
                correlation_id:   stgGr.getValue('moref'),
                u_moref:          stgGr.getValue('moref'),
                u_instance_uuid:  stgGr.getValue('instance_uuid'),
                u_bios_uuid:      stgGr.getValue('bios_uuid'),
                vcpu_count:       stgGr.getValue('cpu_count'),
                memory:           String(parseFloat(stgGr.getValue('memory_size_gb') || 0) * 1024),
                guest_os:         stgGr.getValue('guest_os'),
                host_name:        stgGr.getValue('guest_hostname'),
                num_disks:        stgGr.getValue('num_disks'),
                num_nics:         stgGr.getValue('num_nics'),
                hardware_version: stgGr.getValue('hardware_version'),
                operational_status: powerState,
                install_status:   '1',
                discovery_source: this.source
            },
            identifiers: [
                { className: 'cmdb_ci_vmware_instance', field: 'u_instance_uuid', value: stgGr.getValue('instance_uuid') },
                { className: 'cmdb_ci_vmware_instance', field: 'u_bios_uuid',     value: stgGr.getValue('bios_uuid') },
                { className: 'cmdb_ci_vmware_instance', field: 'correlation_id',  value: stgGr.getValue('moref') }
            ]
        };
    },

    buildDatastorePayload: function(stgGr) {
        return {
            className: 'cmdb_ci_datastore',
            values: {
                name:             stgGr.getValue('name'),
                correlation_id:   stgGr.getValue('moref'),
                u_moref:          stgGr.getValue('moref'),
                u_type:           stgGr.getValue('type'),
                disk_space:       stgGr.getValue('capacity_gb'),
                u_free_space_gb:  stgGr.getValue('free_space_gb'),
                u_accessible:     stgGr.getValue('accessible'),
                install_status:   '1',
                operational_status: '1',
                discovery_source: this.source
            },
            identifiers: [
                { className: 'cmdb_ci_datastore', field: 'correlation_id', value: stgGr.getValue('moref') },
                { className: 'cmdb_ci_datastore', field: 'name',           value: stgGr.getValue('name') }
            ]
        };
    },

    buildDatastoreClusterPayload: function(stgGr) {
        return {
            className: 'cmdb_ci_storage_pool',
            values: {
                name:             stgGr.getValue('name'),
                correlation_id:   stgGr.getValue('moref'),
                u_moref:          stgGr.getValue('moref'),
                u_sdrs_enabled:   stgGr.getValue('sdrs_enabled'),
                disk_space:       stgGr.getValue('capacity_gb'),
                u_free_space_gb:  stgGr.getValue('free_space_gb'),
                install_status:   '1',
                operational_status: '1',
                discovery_source: this.source
            },
            identifiers: [
                { className: 'cmdb_ci_storage_pool', field: 'correlation_id', value: stgGr.getValue('moref') },
                { className: 'cmdb_ci_storage_pool', field: 'name',           value: stgGr.getValue('name') }
            ]
        };
    },

    buildDVSPayload: function(stgGr) {
        return {
            className: 'cmdb_ci_dvs_switch',
            values: {
                name:             stgGr.getValue('name'),
                correlation_id:   stgGr.getValue('moref'),
                u_moref:          stgGr.getValue('moref'),
                u_dvs_uuid:       stgGr.getValue('dvs_uuid'),
                u_num_ports:      stgGr.getValue('num_ports'),
                u_uplink_count:   stgGr.getValue('uplink_count'),
                install_status:   '1',
                operational_status: '1',
                discovery_source: this.source
            },
            identifiers: [
                { className: 'cmdb_ci_dvs_switch', field: 'u_dvs_uuid',     value: stgGr.getValue('dvs_uuid') },
                { className: 'cmdb_ci_dvs_switch', field: 'correlation_id', value: stgGr.getValue('moref') },
                { className: 'cmdb_ci_dvs_switch', field: 'name',           value: stgGr.getValue('name') }
            ]
        };
    },

    // ─── IRE Submission ──────────────────────────────────────────────────────

    /**
     * Submit a single CI payload to the IRE.
     * Uses sn_ire.IdentificationEngine.identifyCI()
     *
     * @param {object} payload - Built by one of the build*Payload methods above
     * @returns {string} sys_id of the created/matched CI, or ''
     */
    submitToIRE: function(payload) {
        try {
            var input = new GlideInputDocument(payload.className);

            // Set field values
            for (var field in payload.values) {
                if (payload.values.hasOwnProperty(field)) {
                    input.setValue(field, payload.values[field]);
                }
            }

            var result = sn_ire.IdentificationEngine.identifyCI(
                this.source,
                payload.className,
                input
            );

            if (result && result.getIdentifiedCI) {
                var ciGr = result.getIdentifiedCI();
                var sysId = ciGr ? ciGr.getUniqueValue() : '';
                this.logger.debug('IRE identified CI: ' + payload.className +
                    ' → ' + sysId);
                return sysId;
            }

        } catch (e) {
            this.logger.error('IRE submission failed for ' + payload.className +
                ': ' + e.message);
        }
        return '';
    },

    /**
     * Alternative: build a full IRE REST API payload for bulk submission.
     * Returns the JSON body structure for POST /api/now/identificationengine
     */
    buildBulkIREPayload: function(items) {
        var payload = {
            items: [],
            relations: []
        };

        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            payload.items.push({
                className:        item.className,
                values:           item.values,
                identifiers:      item.identifiers,
                lookup_table:     item.className,
                lookup_field:     'correlation_id'
            });
        }

        return payload;
    },

    /**
     * Submit a bulk IRE payload via the IRE REST API through MID Server.
     * Preferred for large batches.
     */
    submitBulkIRE: function(items) {
        if (!items || items.length === 0) return [];

        var cfg  = new VCenterConfig();
        var body = this.buildBulkIREPayload(items);

        try {
            var sm = new sn_ws.RESTMessageV2();
            sm.setHttpMethod('POST');
            sm.setEndpoint('/api/now/identificationengine');
            sm.setRequestHeader('Content-Type', 'application/json');
            sm.setRequestHeader('Accept', 'application/json');
            sm.setRequestBody(JSON.stringify(body));

            var resp   = sm.execute();
            var status = parseInt(resp.getStatusCode());
            var result = this.utils.parseJSON(resp.getBody());

            if (status === 200 && result) {
                return result.result || [];
            } else {
                this.logger.error('Bulk IRE submission failed. Status: ' + status);
                return [];
            }
        } catch (e) {
            this.logger.error('Bulk IRE exception: ' + e.message);
            return [];
        }
    },

    type: 'VCenterIREPayloadBuilder'
};
