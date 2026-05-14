/**
 * Script Include: VCenterRelationshipBuilder
 * Scope: x_ftl_vcenter_etl
 *
 * Creates CMDB relationships between vCenter CIs using cmdb_rel_ci.
 *
 * Relationship matrix:
 *   vCenter         → Datacenter        (Contains::Contained by)
 *   Datacenter      → Cluster           (Contains::Contained by)
 *   Cluster         → ESXi Host         (Contains::Contained by)
 *   ESXi Host       → VM                (Hosts::Hosted by)
 *   Cluster         → Datastore         (Uses::Used by)
 *   ESXi Host       → Datastore         (Uses::Used by)
 *   Distributed DVS → ESXi Host         (Connects::Connected by)
 *   VM              → Datastore         (Uses::Used by)
 *
 * All parent/child lookups use correlation_id (= vCenter MoRef).
 */
var VCenterRelationshipBuilder = Class.create();
VCenterRelationshipBuilder.prototype = {

    initialize: function(runId) {
        this.runId  = runId || '';
        this.logger = new VCenterLogger('VCenterRelationshipBuilder', runId);
        this.utils  = new VCenterUtils();
        this._relTypeCache = {};
        this.stats  = { created: 0, existing: 0, skipped: 0, errors: 0 };
    },

    // ─── Public Relationship Methods ─────────────────────────────────────────

    /** vCenter instance → Datacenter */
    linkVCenterToDatacenter: function(vcenterSysId, datacenterSysId) {
        return this._createRel(vcenterSysId, datacenterSysId,
            'cmdb_ci_vcenter', 'cmdb_ci_datacenter', 'Contains::Contained by');
    },

    /** Datacenter → Cluster */
    linkDatacenterToCluster: function(datacenterSysId, clusterSysId) {
        return this._createRel(datacenterSysId, clusterSysId,
            'cmdb_ci_datacenter', 'cmdb_ci_cluster', 'Contains::Contained by');
    },

    /** Cluster → ESXi Host */
    linkClusterToHost: function(clusterSysId, hostSysId) {
        return this._createRel(clusterSysId, hostSysId,
            'cmdb_ci_cluster', 'cmdb_ci_esx_server', 'Contains::Contained by');
    },

    /** ESXi Host → Virtual Machine */
    linkHostToVM: function(hostSysId, vmSysId) {
        return this._createRel(hostSysId, vmSysId,
            'cmdb_ci_esx_server', 'cmdb_ci_vmware_instance', 'Hosts::Hosted by');
    },

    /** Cluster → Datastore */
    linkClusterToDatastore: function(clusterSysId, datastoreSysId) {
        return this._createRel(clusterSysId, datastoreSysId,
            'cmdb_ci_cluster', 'cmdb_ci_datastore', 'Uses::Used by');
    },

    /** ESXi Host → Datastore */
    linkHostToDatastore: function(hostSysId, datastoreSysId) {
        return this._createRel(hostSysId, datastoreSysId,
            'cmdb_ci_esx_server', 'cmdb_ci_datastore', 'Uses::Used by');
    },

    /** Distributed Switch → ESXi Host */
    linkDVSToHost: function(dvsSysId, hostSysId) {
        return this._createRel(dvsSysId, hostSysId,
            'cmdb_ci_dvs_switch', 'cmdb_ci_esx_server', 'Connects::Connected by');
    },

    /** VM → Datastore */
    linkVMToDatastore: function(vmSysId, datastoreSysId) {
        return this._createRel(vmSysId, datastoreSysId,
            'cmdb_ci_vmware_instance', 'cmdb_ci_datastore', 'Uses::Used by');
    },

    /**
     * Bulk build all relationships from staging tables.
     * Should be called after all CI IRE loads are complete.
     */
    buildAllRelationships: function() {
        this.logger.info('Building all vCenter CMDB relationships');

        this._buildVCenterToDatacenterRels();
        this._buildDatacenterToClusterRels();
        this._buildClusterToHostRels();
        this._buildHostToVMRels();
        this._buildClusterToDatastoreRels();
        this._buildHostToDatastoreRels();
        this._buildDVSToHostRels();
        this._buildVMToDatastoreRels();

        this.logger.info('Relationship build complete: ' + JSON.stringify(this.stats));
        return this.stats;
    },

    // ─── Batch Relationship Builders ─────────────────────────────────────────

    _buildVCenterToDatacenterRels: function() {
        var vcSysId = this._getCISysIdBySource('cmdb_ci_vcenter');
        if (!vcSysId) return;

        var gr = new GlideRecord('x_ftl_vcenter_etl_datacenter_stg');
        gr.addQuery('stg_state', 'processed');
        gr.query();
        while (gr.next()) {
            var dcSysId = this._getCISysIdByMoRef(
                'cmdb_ci_datacenter', gr.getValue('moref'));
            if (dcSysId) {
                this.linkVCenterToDatacenter(vcSysId, dcSysId);
            }
        }
    },

    _buildDatacenterToClusterRels: function() {
        var gr = new GlideRecord('x_ftl_vcenter_etl_cluster_stg');
        gr.addQuery('stg_state', 'processed');
        gr.query();
        while (gr.next()) {
            var dcSysId = this._getCISysIdByMoRef(
                'cmdb_ci_datacenter', gr.getValue('datacenter_ref'));
            var clSysId = this._getCISysIdByMoRef(
                'cmdb_ci_cluster', gr.getValue('moref'));
            if (dcSysId && clSysId) {
                this.linkDatacenterToCluster(dcSysId, clSysId);
            }
        }
    },

    _buildClusterToHostRels: function() {
        var gr = new GlideRecord('x_ftl_vcenter_etl_host_stg');
        gr.addQuery('stg_state', 'processed');
        gr.addQuery('cluster_ref', '!=', '');
        gr.query();
        while (gr.next()) {
            var clSysId = this._getCISysIdByMoRef(
                'cmdb_ci_cluster', gr.getValue('cluster_ref'));
            var hSysId  = this._getCISysIdByMoRef(
                'cmdb_ci_esx_server', gr.getValue('moref'));
            if (clSysId && hSysId) {
                this.linkClusterToHost(clSysId, hSysId);
            }
        }
    },

    _buildHostToVMRels: function() {
        var gr = new GlideRecord('x_ftl_vcenter_etl_vm_stg');
        gr.addQuery('stg_state', 'processed');
        gr.addQuery('host_ref', '!=', '');
        gr.query();
        while (gr.next()) {
            var hSysId  = this._getCISysIdByMoRef(
                'cmdb_ci_esx_server', gr.getValue('host_ref'));
            var vmSysId = this._getCISysIdByMoRef(
                'cmdb_ci_vmware_instance', gr.getValue('moref'));
            if (hSysId && vmSysId) {
                this.linkHostToVM(hSysId, vmSysId);
            }
        }
    },

    _buildClusterToDatastoreRels: function() {
        // Datastores visible to a cluster — stored in staging after enrichment
        var gr = new GlideRecord('x_ftl_vcenter_etl_datastore_stg');
        gr.addQuery('stg_state', 'processed');
        gr.addQuery('cluster_ref', '!=', '');
        gr.query();
        while (gr.next()) {
            var clSysId = this._getCISysIdByMoRef(
                'cmdb_ci_cluster', gr.getValue('cluster_ref'));
            var dsSysId = this._getCISysIdByMoRef(
                'cmdb_ci_datastore', gr.getValue('moref'));
            if (clSysId && dsSysId) {
                this.linkClusterToDatastore(clSysId, dsSysId);
            }
        }
    },

    _buildHostToDatastoreRels: function() {
        var gr = new GlideRecord('x_ftl_vcenter_etl_datastore_stg');
        gr.addQuery('stg_state', 'processed');
        gr.addQuery('host_ref', '!=', '');
        gr.query();
        while (gr.next()) {
            var hSysId  = this._getCISysIdByMoRef(
                'cmdb_ci_esx_server', gr.getValue('host_ref'));
            var dsSysId = this._getCISysIdByMoRef(
                'cmdb_ci_datastore', gr.getValue('moref'));
            if (hSysId && dsSysId) {
                this.linkHostToDatastore(hSysId, dsSysId);
            }
        }
    },

    _buildDVSToHostRels: function() {
        var gr = new GlideRecord('x_ftl_vcenter_etl_dvs_stg');
        gr.addQuery('stg_state', 'processed');
        gr.query();
        while (gr.next()) {
            var dvsSysId = this._getCISysIdByMoRef(
                'cmdb_ci_dvs_switch', gr.getValue('moref'));
            // DVS-to-host relationships stored in a relationship staging field
            var hostRefs = gr.getValue('host_refs') || '';
            var hosts    = hostRefs ? hostRefs.split(',') : [];
            for (var i = 0; i < hosts.length; i++) {
                var hSysId = this._getCISysIdByMoRef('cmdb_ci_esx_server', hosts[i].trim());
                if (dvsSysId && hSysId) {
                    this.linkDVSToHost(dvsSysId, hSysId);
                }
            }
        }
    },

    _buildVMToDatastoreRels: function() {
        var gr = new GlideRecord('x_ftl_vcenter_etl_vm_stg');
        gr.addQuery('stg_state', 'processed');
        gr.addQuery('datastore_refs', '!=', '');
        gr.query();
        while (gr.next()) {
            var vmSysId   = this._getCISysIdByMoRef(
                'cmdb_ci_vmware_instance', gr.getValue('moref'));
            var dsRefs    = (gr.getValue('datastore_refs') || '').split(',');
            for (var i = 0; i < dsRefs.length; i++) {
                var dsSysId = this._getCISysIdByMoRef(
                    'cmdb_ci_datastore', dsRefs[i].trim());
                if (vmSysId && dsSysId) {
                    this.linkVMToDatastore(vmSysId, dsSysId);
                }
            }
        }
    },

    // ─── Core Relationship Creator ───────────────────────────────────────────

    /**
     * Create a cmdb_rel_ci record if it does not already exist.
     */
    _createRel: function(parentSysId, childSysId, parentClass, childClass, relTypeName) {
        if (!parentSysId || !childSysId) {
            this.stats.skipped++;
            return false;
        }

        var relTypeId = this._getRelTypeId(relTypeName);
        if (!relTypeId) {
            this.logger.warn('Relationship type not found: ' + relTypeName);
            this.stats.skipped++;
            return false;
        }

        // Check for existing relationship
        var existing = new GlideRecord('cmdb_rel_ci');
        existing.addQuery('parent',   parentSysId);
        existing.addQuery('child',    childSysId);
        existing.addQuery('type',     relTypeId);
        existing.setLimit(1);
        existing.query();

        if (existing.next()) {
            this.stats.existing++;
            return true;
        }

        // Create new
        try {
            var rel = new GlideRecord('cmdb_rel_ci');
            rel.initialize();
            rel.setValue('parent',   parentSysId);
            rel.setValue('child',    childSysId);
            rel.setValue('type',     relTypeId);
            rel.insert();
            this.stats.created++;
            this.logger.debug('Created rel: ' + parentClass + '→' + childClass +
                ' [' + relTypeName + ']');
            return true;
        } catch (e) {
            this.logger.error('Failed to create relationship: ' + e.message);
            this.stats.errors++;
            return false;
        }
    },

    // ─── Lookup Helpers ──────────────────────────────────────────────────────

    /** Resolve relationship type sys_id by name with caching. */
    _getRelTypeId: function(name) {
        if (this._relTypeCache[name]) return this._relTypeCache[name];

        var gr = new GlideRecord('cmdb_rel_type');
        gr.addQuery('name', name);
        gr.setLimit(1);
        gr.query();

        var id = gr.next() ? gr.getUniqueValue() : '';
        this._relTypeCache[name] = id;
        return id;
    },

    /** Find CI sys_id by correlation_id (= vCenter MoRef). */
    _getCISysIdByMoRef: function(table, moref) {
        if (!moref) return '';
        var gr = new GlideRecord(table);
        gr.addQuery('correlation_id', moref);
        gr.setLimit(1);
        gr.query();
        return gr.next() ? gr.getUniqueValue() : '';
    },

    /** Get sys_id of the single vCenter CI (there should be exactly one). */
    _getCISysIdBySource: function(table) {
        var gr = new GlideRecord(table);
        gr.addQuery('discovery_source', 'vCenterETL');
        gr.setLimit(1);
        gr.query();
        return gr.next() ? gr.getUniqueValue() : '';
    },

    type: 'VCenterRelationshipBuilder'
};
