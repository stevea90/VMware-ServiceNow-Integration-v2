# MID Server Configuration Guide

## Overview

All vCenter REST API calls are proxied through a MID Server deployed in the
FT1 data domain. The MID Server acts as a network bridge between ServiceNow
and the vCenter API endpoint, which is not publicly accessible.

---

## Prerequisites

| Requirement | Detail |
|---|---|
| MID Server version | Tokyo (or later) — must support REST proxy |
| OS | Windows Server 2016+ or RHEL 7+ |
| Java | OpenJDK 11 or later (bundled with MID installer) |
| Network access | MID Server → vCenter FQDN:443 (HTTPS) |
| Memory | Minimum 2 GB RAM dedicated to MID Server |
| Disk | Minimum 10 GB for MID Server home |
| ServiceNow access | MID Server → ServiceNow instance URL:443 |

---

## MID Server Installation Steps

### 1. Download MID Server Installer

In ServiceNow:
```
MID Server > Downloads > Select OS
```
Download the appropriate installer for your OS.

### 2. Create MID Server Service Account

```sql
-- In ServiceNow, create a user record:
Username: svc-midserver-ft1
Password: <strong-password>
Roles:    mid_server
          x_ftl_vcenter_etl.etl_user   (custom role for scoped app access)
```

### 3. Install MID Server

**Windows:**
```powershell
# Run as Administrator
.\mid.server.installer.windows.exe
# Follow wizard — set ServiceNow URL and MID credentials
```

**Linux (RHEL/CentOS):**
```bash
sudo mkdir -p /opt/servicenow/mid
sudo tar -xzf mid.server.linux.x86-64.tar.gz -C /opt/servicenow/mid/
cd /opt/servicenow/mid/agent/
cp config.xml.template config.xml
```

Edit `config.xml`:
```xml
<parameters>
  <parameter name="url"          value="https://<instance>.service-now.com"/>
  <parameter name="mid.instance.username" value="svc-midserver-ft1"/>
  <parameter name="mid.instance.password" value="<encrypted-password>"/>
  <parameter name="name"         value="MID-FT1-VCENTER-01"/>
</parameters>
```

```bash
sudo ./start.sh
```

### 4. Validate MID Server in ServiceNow

Navigate to: **MID Servers > Servers**
- Confirm status = **Up**
- Confirm version matches expected

---

## MID Server Configuration for REST Proxy

### Enable REST Capabilities

In ServiceNow, navigate to the MID Server record:
```
MID Servers > MID-FT1-VCENTER-01 > Capabilities
```

Ensure the following capabilities are active:
- `REST`
- `HTTP`
- `SOAP` (optional)

### Configure MID Server IP Range

Set the IP range to include the vCenter FQDN/IP:
```
MID Servers > MID-FT1-VCENTER-01 > IP Ranges
Range: <vCenter_IP>/32   (or the full subnet)
```

### Configure REST Message to Use MID Server

In the Connection & Credential Alias:
```
Table: sys_connection_alias
Name:  x_ftl_vcenter_etl.vcenter_conn
MID Server: MID-FT1-VCENTER-01
```

---

## Connection & Credential Alias Setup

### Step 1: Create Credential

Navigate to: **Connections & Credentials > Credentials > New**
```
Name:            vCenter FT1 Credential
Type:            Basic Auth Credential
Username:        <vcenter-readonly-user>@corp.example.com
Password:        <password>
```

**Note:** Use a dedicated read-only service account in vCenter with:
- Role: `Read-Only` (minimum)
- Scope: Global

### Step 2: Create Connection

Navigate to: **Connections & Credentials > Connections > New**
```
Name:            vCenter FT1 Connection
Connection URL:  https://vcenter-ft1.corp.example.com
Credential:      vCenter FT1 Credential
MID Server:      MID-FT1-VCENTER-01
```

### Step 3: Create Alias

Navigate to: **Connections & Credentials > Connection & Credential Aliases > New**
```
Name:            x_ftl_vcenter_etl.vcenter_conn
Connection:      vCenter FT1 Connection
```

Update system property:
```
x_ftl_vcenter_etl.connection_alias = x_ftl_vcenter_etl.vcenter_conn
x_ftl_vcenter_etl.vcenter_host     = vcenter-ft1.corp.example.com
x_ftl_vcenter_etl.mid_server       = MID-FT1-VCENTER-01
```

---

## MID Server SSL/TLS Configuration

### Option 1: Trust vCenter Certificate (Recommended for Enterprise CA)

If vCenter uses a certificate signed by a trusted enterprise CA:
```bash
# Import CA cert into MID Server JRE keystore
keytool -import -alias vcenter-ca \
  -file /path/to/corp-ca.crt \
  -keystore /opt/servicenow/mid/agent/jre/lib/security/cacerts \
  -storepass changeit
```

Restart MID Server after import.

### Option 2: Disable Certificate Validation (Dev Only)

For development/testing ONLY — never in production:

In `config.xml`:
```xml
<parameter name="https.client.allow-insecure-ssl" value="true"/>
```

### Option 3: Import vCenter Self-Signed Cert

```bash
# Export cert from vCenter
openssl s_client -connect vcenter-ft1.corp.example.com:443 \
  -showcerts </dev/null 2>/dev/null | openssl x509 -outform PEM > vcenter.pem

# Import into MID Server JRE
keytool -import -alias vcenter-ft1 \
  -file vcenter.pem \
  -keystore /opt/servicenow/mid/agent/jre/lib/security/cacerts \
  -storepass changeit
```

---

## MID Server Monitoring

### ECC Queue Monitoring

The ETL writes completion events to `ecc_queue` for MID Server tracking:
```
Topic:   VCenterETL
Name:    run_complete
Payload: { "run_id": "...", "status": "success", "duration": "..." }
```

Monitor via: **MID Servers > ECC Queue**

### MID Server Health Checks

Recommended alerts to configure:
1. MID Server status changes from **Up** to any other state
2. ECC queue backlog > 1000 records
3. Last activity timestamp > 30 minutes old during ETL window

### Log Locations

**Windows:**
```
C:\ServiceNow\mid\agent\logs\agent0.log
```

**Linux:**
```
/opt/servicenow/mid/agent/logs/agent0.log
```

Set log level to DEBUG during initial testing:
```xml
<!-- In config.xml -->
<parameter name="loglevel" value="debug"/>
```

---

## Network Requirements

| Source | Destination | Port | Protocol | Purpose |
|---|---|---|---|---|
| MID Server | ServiceNow instance | 443 | HTTPS | ECC queue, REST API |
| MID Server | vCenter FQDN | 443 | HTTPS | vCenter REST API |
| ServiceNow | (no direct access needed) | — | — | All routed via MID |

Firewall rule example:
```
ALLOW TCP 10.1.5.20 (MID Server) → 10.1.1.100 (vCenter) : 443
ALLOW TCP 10.1.5.20 (MID Server) → <instance>.service-now.com : 443
```

---

## Multiple vCenter Support (Future)

To support additional vCenter instances:
1. Deploy an additional MID Server or use existing if network-accessible
2. Create additional Connection & Credential Alias records
3. Add new sys_properties entries for each vCenter:
   ```
   x_ftl_vcenter_etl.vcenter_host_2 = vcenter-ft2.corp.example.com
   x_ftl_vcenter_etl.connection_alias_2 = x_ftl_vcenter_etl.vcenter_conn_2
   ```
4. Extend `VCenterETLOrchestrator` to loop over configured vCenter instances
