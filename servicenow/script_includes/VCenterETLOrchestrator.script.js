/**
 * Script Include: VCenterETLOrchestrator
 * Scope: x_ftl_vcenter_etl
 *
 * Top-level orchestrator for the vCenter → CMDB ETL pipeline.
 *
 * Pipeline phases:
 *   Phase 0: Validate configuration
 *   Phase 1: Authenticate to vCenter
 *   Phase 2: Extract all object types from vCenter API
 *   Phase 3: Load raw data into staging tables
 *   Phase 4: Transform staging → CMDB via IRE
 *   Phase 5: Build CMDB relationships
 *   Phase 6: Staleness check + CI retirement
 *   Phase 7: Notification & run summary
 *
 * Called by the VCenterDailyImportJob scheduled job.
 */
var VCenterETLOrchestrator = Class.create();
VCenterETLOrchestrator.prototype = {

    initialize: function() {
        this.utils    = new VCenterUtils();
        this.runId    = this.utils.generateRunId();
        this.cfg      = new VCenterConfig();
        this.logger   = new VCenterLogger('VCenterETLOrchestrator', this.runId);
        this.api      = new VCenterAPIClient(this.runId);
        this.staging  = new VCenterStagingLoader(this.runId);
        this.transform = new VCenterTransformEngine(this.runId);
        this.relBuilder = new VCenterRelationshipBuilder(this.runId);
        this.stalenessMgr = new VCenterStalenessManager(this.runId);

        this.runRecord = null;     // x_ftl_vcenter_etl_run record
        this.startTime = new GlideDateTime();
        this.phaseStats = {};
    },

    /**
     * Entry point — runs the full ETL pipeline.
     * Returns a summary object.
     */
    run: function() {
        this.logger.info('=== vCenter ETL Run START. RunID: ' + this.runId + ' ===');
        this._createRunRecord();

        try {
            // Phase 0: Config validation
            var missing = this.cfg.validate();
            if (missing.length > 0) {
                this._fail('Configuration validation failed. Missing: ' + missing.join(', '));
                return this._summary('failed');
            }
            this._updateRunPhase('extracting');

            // Phase 1: Authenticate
            if (!this.api.connect()) {
                this._fail('vCenter authentication failed');
                return this._summary('failed');
            }

            // Phase 2+3: Extract all object types and stage them
            this._extractAndStage();

            // Disconnect from vCenter before heavy processing
            this.api.disconnect();

            // Phase 4: Transform staging → CMDB via IRE
            this._updateRunPhase('transforming');
            this.phaseStats.transform = this.transform.runAll();

            // Phase 5: Build relationships
            this._updateRunPhase('relationships');
            this.phaseStats.relationships = this.relBuilder.buildAllRelationships();

            // Phase 6: Staleness check
            this._updateRunPhase('staleness');
            this.phaseStats.staleness = this.stalenessMgr.runCheck();
            this.stalenessMgr.cleanOrphanedRelationships();

            // Phase 7: Finish
            this._updateRunPhase('completed');
            this._completeRunRecord('success');
            this.logger.info('=== vCenter ETL Run COMPLETE. RunID: ' + this.runId + ' ===');

        } catch (e) {
            this.logger.error('Unhandled orchestrator exception: ' + e.message);
            this._fail('Unhandled exception: ' + e.message);
            try { this.api.disconnect(); } catch (ex) { /* ignore */ }
            return this._summary('failed');
        }

        var summary = this._summary('success');
        this._notify(summary);
        return summary;
    },

    // ─── Extract & Stage ─────────────────────────────────────────────────────

    _extractAndStage: function() {
        this.logger.info('Phase: Extract & Stage');

        // vCenter version/info (single record)
        var vcInfo = this.api.getVCenterInfo();
        if (vcInfo) {
            vcInfo.vcenter_id = this.cfg.vcenterHost();
            this.staging.loadVCenter(vcInfo);
        }

        // Datacenters
        var datacenters = this.api.getDatacenters();
        this.phaseStats.staging_datacenter =
            this.staging.bulkLoad('datacenter', datacenters);

        // Clusters
        var clusters = this.api.getClusters();
        this.phaseStats.staging_cluster =
            this.staging.bulkLoad('cluster', clusters);

        // ESXi Hosts
        var hosts = this.api.getHosts();
        this.phaseStats.staging_host =
            this.staging.bulkLoad('host', hosts);

        // VMs — fetch summary list, then enrich top N with detail if needed
        var vms = this.api.getVMs();
        this.phaseStats.staging_vm =
            this.staging.bulkLoad('vm', vms);

        // Datastores
        var datastores = this.api.getDatastores();
        this.phaseStats.staging_datastore =
            this.staging.bulkLoad('datastore', datastores);

        // Datastore Clusters
        var dsClusters = this.api.getDatastoreClusters();
        this.phaseStats.staging_ds_cluster =
            this.staging.bulkLoad('datastore_cluster', dsClusters);

        // Distributed Switches
        var dvs = this.api.getDistributedSwitches();
        this.phaseStats.staging_dvs =
            this.staging.bulkLoad('dvs', dvs);

        this.logger.info('Staging complete: ' + JSON.stringify(this.staging.getStats()));
    },

    // ─── Run Record Lifecycle ────────────────────────────────────────────────

    _createRunRecord: function() {
        try {
            var gr = new GlideRecord('x_ftl_vcenter_etl_run');
            gr.initialize();
            gr.setValue('run_id',     this.runId);
            gr.setValue('status',     'running');
            gr.setValue('started_at', this.startTime.getValue());
            gr.setValue('vcenter',    this.cfg.vcenterHost());
            gr.insert();
            this.runRecord = gr.getUniqueValue();
        } catch (e) {
            this.logger.warn('Could not create run record: ' + e.message);
        }
    },

    _updateRunPhase: function(phase) {
        this.logger.info('Entering phase: ' + phase);
        if (!this.runRecord) return;
        try {
            var gr = new GlideRecord('x_ftl_vcenter_etl_run');
            if (gr.get(this.runRecord)) {
                gr.setValue('current_phase', phase);
                gr.update();
            }
        } catch (e) { /* non-fatal */ }
    },

    _completeRunRecord: function(status) {
        if (!this.runRecord) return;
        try {
            var ended = new GlideDateTime();
            var gr = new GlideRecord('x_ftl_vcenter_etl_run');
            if (gr.get(this.runRecord)) {
                gr.setValue('status',     status);
                gr.setValue('ended_at',   ended.getValue());
                gr.setValue('stats_json', JSON.stringify(this.phaseStats));
                gr.update();
            }
        } catch (e) { /* non-fatal */ }
    },

    _fail: function(reason) {
        this.logger.error('ETL run failed: ' + reason);
        this._updateRunPhase('failed');
        this._completeRunRecord('failed');
        this._notifyFailure(reason);
    },

    // ─── Notifications ───────────────────────────────────────────────────────

    _notify: function(summary) {
        var email = this.cfg.notifyEmail();
        if (!email || summary.status === 'success') return;
        this._sendNotification(email, 'vCenter ETL: ' + summary.status,
            JSON.stringify(summary, null, 2));
    },

    _notifyFailure: function(reason) {
        var email = this.cfg.notifyEmail();
        if (!email) return;
        this._sendNotification(email,
            'vCenter ETL FAILED - RunID: ' + this.runId,
            'Run ID: ' + this.runId + '\nReason: ' + reason);
    },

    _sendNotification: function(toEmail, subject, body) {
        try {
            var email = new GlideEmailOutbound();
            email.setFrom('noreply@servicenow.com');
            email.addAddress('to', toEmail);
            email.setSubject(subject);
            email.setBody(body);
            email.send();
        } catch (e) {
            this.logger.warn('Notification send failed: ' + e.message);
        }
    },

    // ─── Summary ─────────────────────────────────────────────────────────────

    _summary: function(status) {
        var ended    = new GlideDateTime();
        var duration = GlideDateTime.subtract(this.startTime, ended);

        return {
            runId:    this.runId,
            status:   status,
            started:  this.startTime.getValue(),
            ended:    ended.getValue(),
            duration: duration.getDisplayValue(),
            phases:   this.phaseStats
        };
    },

    type: 'VCenterETLOrchestrator'
};
