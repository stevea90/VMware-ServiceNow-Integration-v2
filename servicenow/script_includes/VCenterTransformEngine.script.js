/**
 * Script Include: VCenterTransformEngine
 * Scope: x_ftl_vcenter_etl
 *
 * Reads staging records and submits them to IRE via VCenterIREPayloadBuilder.
 * Processes in batches (batchSize from config) to avoid governor limits.
 *
 * Execution order (dependency-safe):
 *   1. vCenter instance
 *   2. Datacenters
 *   3. Clusters
 *   4. ESXi Hosts
 *   5. VMs
 *   6. Datastores
 *   7. Datastore Clusters
 *   8. Distributed Switches
 */
var VCenterTransformEngine = Class.create();
VCenterTransformEngine.prototype = {

    PIPELINE: [
        {
            name:      'vcenter',
            table:     'x_ftl_vcenter_etl_vcenter_stg',
            ciClass:   'cmdb_ci_vcenter',
            builder:   'buildVCenterPayload'
        },
        {
            name:      'datacenter',
            table:     'x_ftl_vcenter_etl_datacenter_stg',
            ciClass:   'cmdb_ci_datacenter',
            builder:   'buildDatacenterPayload'
        },
        {
            name:      'cluster',
            table:     'x_ftl_vcenter_etl_cluster_stg',
            ciClass:   'cmdb_ci_cluster',
            builder:   'buildClusterPayload'
        },
        {
            name:      'host',
            table:     'x_ftl_vcenter_etl_host_stg',
            ciClass:   'cmdb_ci_esx_server',
            builder:   'buildHostPayload'
        },
        {
            name:      'vm',
            table:     'x_ftl_vcenter_etl_vm_stg',
            ciClass:   'cmdb_ci_vmware_instance',
            builder:   'buildVMPayload'
        },
        {
            name:      'datastore',
            table:     'x_ftl_vcenter_etl_datastore_stg',
            ciClass:   'cmdb_ci_datastore',
            builder:   'buildDatastorePayload'
        },
        {
            name:      'ds_cluster',
            table:     'x_ftl_vcenter_etl_ds_cluster_stg',
            ciClass:   'cmdb_ci_storage_pool',
            builder:   'buildDatastoreClusterPayload'
        },
        {
            name:      'dvs',
            table:     'x_ftl_vcenter_etl_dvs_stg',
            ciClass:   'cmdb_ci_dvs_switch',
            builder:   'buildDVSPayload'
        }
    ],

    initialize: function(runId) {
        this.runId    = runId || '';
        this.logger   = new VCenterLogger('VCenterTransformEngine', runId);
        this.ireBuilder = new VCenterIREPayloadBuilder(runId);
        this.cfg      = new VCenterConfig();
        this.stats    = {};
    },

    /**
     * Run the full transform pipeline.
     * Returns aggregate stats.
     */
    runAll: function() {
        this.logger.info('Starting transform pipeline. Run ID: ' + this.runId);

        for (var i = 0; i < this.PIPELINE.length; i++) {
            var stage = this.PIPELINE[i];
            this.logger.info('Transforming: ' + stage.name);
            this.stats[stage.name] = this._processStage(stage);
        }

        this.logger.info('Transform pipeline complete: ' + JSON.stringify(this.stats));
        return this.stats;
    },

    /**
     * Process a single pipeline stage: read staging → build IRE payload → submit.
     */
    _processStage: function(stage) {
        var counts    = { processed: 0, succeeded: 0, failed: 0 };
        var batchSize = this.cfg.batchSize();
        var batch     = [];
        var sysIds    = []; // sys_ids of staging rows in current batch

        var gr = new GlideRecord(stage.table);
        gr.addQuery('stg_state', 'ready');
        gr.query();

        while (gr.next()) {
            var payload = null;
            try {
                payload = this.ireBuilder[stage.builder](gr);
            } catch (e) {
                this.logger.error('Payload build error [' + stage.name + ']: ' + e.message);
                this._markStaging(stage.table, gr.getUniqueValue(), 'error');
                counts.failed++;
                continue;
            }

            if (payload) {
                batch.push(payload);
                sysIds.push(gr.getUniqueValue());
            }

            if (batch.length >= batchSize) {
                var results = this._submitBatch(stage.name, batch);
                counts.succeeded += results.succeeded;
                counts.failed    += results.failed;
                this._markBatch(stage.table, sysIds, 'processed');
                batch  = [];
                sysIds = [];
            }

            counts.processed++;
        }

        // Flush remaining
        if (batch.length > 0) {
            var rem = this._submitBatch(stage.name, batch);
            counts.succeeded += rem.succeeded;
            counts.failed    += rem.failed;
            this._markBatch(stage.table, sysIds, 'processed');
        }

        this.logger.info(stage.name + ' transform: ' + JSON.stringify(counts));
        return counts;
    },

    /**
     * Submit a batch of payloads to IRE.
     */
    _submitBatch: function(stageName, batch) {
        var results = { succeeded: 0, failed: 0 };

        for (var i = 0; i < batch.length; i++) {
            try {
                var sysId = this.ireBuilder.submitToIRE(batch[i]);
                if (sysId) {
                    results.succeeded++;
                } else {
                    results.failed++;
                    this.logger.warn('IRE returned no sys_id for ' +
                        stageName + ' payload index ' + i);
                }
            } catch (e) {
                results.failed++;
                this.logger.error('IRE submit exception [' + stageName + ']: ' + e.message);
            }
        }

        return results;
    },

    /** Update staging row state field. */
    _markStaging: function(table, sysId, state) {
        var gr = new GlideRecord(table);
        if (gr.get(sysId)) {
            gr.setValue('stg_state', state);
            gr.update();
        }
    },

    /** Bulk-update a list of staging row sys_ids to a given state. */
    _markBatch: function(table, sysIds, state) {
        for (var i = 0; i < sysIds.length; i++) {
            this._markStaging(table, sysIds[i], state);
        }
    },

    type: 'VCenterTransformEngine'
};
