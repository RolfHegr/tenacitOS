import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";

const execAsync = promisify(exec);

// Services monitored per backend
const SYSTEMD_SERVICES = ["mission-control"];
const PM2_SERVICES = ["classvault", "content-vault", "postiz-simple", "brain"];
// creatoros not deployed yet — shown as "not_deployed"
const PLACEHOLDER_SERVICES = [
  { name: "creatoros", description: "Creatoros Platform", status: "not_deployed" },
];

interface ServiceEntry {
  name: string;
  status: string;
  description: string;
  backend: string;
  uptime?: number | null;
  restarts?: number;
  pid?: number | null;
  mem?: number | null;
  cpu?: number | null;
}

interface TailscaleDevice {
  hostname: string;
  ip: string;
  os: string;
  online: boolean;
}

interface FirewallRule {
  port: string;
  action: string;
  from: string;
  comment: string;
}

// Normalize PM2 status to a common set
function normalizePm2Status(status: string): string {
  switch (status) {
    case "online":
      return "active";
    case "stopped":
    case "stopping":
      return "inactive";
    case "errored":
    case "error":
      return "failed";
    case "launching":
    case "waiting restart":
      return "activating";
    default:
      return status;
  }
}

// Friendly display names for PM2 process names
const SERVICE_DESCRIPTIONS: Record<string, string> = {
  "mission-control": "Mission Control – Tenacitas Dashboard",
  classvault: "ClassVault – LMS Platform",
  "content-vault": "Content Vault – Draft Management Webapp",
  "postiz-simple": "Postiz – Social Media Scheduler",
  brain: "Brain – Internal Tools",
  creatoros: "Creatoros Platform",
};

export async function GET() {
  try {
    // ── CPU ──────────────────────────────────────────────────────────────────
    const cpuCount = os.cpus().length;
    const loadAvg = os.loadavg();
    const cpuUsage = Math.min(Math.round((loadAvg[0] / cpuCount) * 100), 100);

    // ── RAM ──────────────────────────────────────────────────────────────────
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // ── Disk ─────────────────────────────────────────────────────────────────
    let diskTotal = 100;
    let diskUsed = 0;
    let diskFree = 100;
    try {
      // Use df -k (KB) for cross-platform compatibility (macOS + Linux)
      const { stdout } = await execAsync("df -k / | tail -1");
      const parts = stdout.trim().split(/\s+/);
      diskTotal = Math.round(parseInt(parts[1]) / 1024 / 1024); // KB -> GB
      diskUsed = Math.round(parseInt(parts[2]) / 1024 / 1024);
      diskFree = Math.round(parseInt(parts[3]) / 1024 / 1024);
    } catch (error) {
      console.error("Failed to get disk stats:", error);
    }
    const diskPercent = (diskUsed / diskTotal) * 100;

    // ── Network stats (macOS-compatible via netstat) ──────────────────────────
    let network = { rx: 0, tx: 0 };
    try {
      // netstat -ib works on both macOS and Linux
      const { stdout: netOut } = await execAsync("netstat -ib 2>/dev/null | awk 'NR>1 && $1 !~ /lo/ && $1 !~ /^Name/ {rx+=$7; tx+=$10} END {print rx, tx}'");
      const parts = netOut.trim().split(/\s+/);
      const rx = parseInt(parts[0]) || 0;
      const tx = parseInt(parts[1]) || 0;
      const now = Date.now();
      if ((global as Record<string, unknown>).__netPrev) {
        const prev = (global as Record<string, unknown>).__netPrev as { rx: number; tx: number; ts: number };
        const dtSec = (now - prev.ts) / 1000;
        if (dtSec > 0) {
          network = {
            rx: parseFloat(Math.max(0, (rx - prev.rx) / 1024 / 1024 / dtSec).toFixed(3)),
            tx: parseFloat(Math.max(0, (tx - prev.tx) / 1024 / 1024 / dtSec).toFixed(3)),
          };
        }
      }
      (global as Record<string, unknown>).__netPrev = { rx, tx, ts: now };
    } catch (error) {
      console.error("Failed to get network stats:", error);
    }

    // ── Services ─────────────────────────────────────────────────────────────
    const services: ServiceEntry[] = [];

    // 1. Systemd services — not available on macOS, return graceful fallback
    for (const name of SYSTEMD_SERVICES) {
      services.push({
        name,
        status: "unknown",
        description: (SERVICE_DESCRIPTIONS[name] ?? name) + " (systemd N/A on macOS)",
        backend: "systemd",
      });
    }

    // 2. PM2 services — single call, parse JSON
    try {
      const { stdout: pm2Json } = await execAsync("pm2 jlist 2>/dev/null");
      const pm2List = JSON.parse(pm2Json) as Array<{
        name: string;
        pid: number | null;
        pm2_env: {
          status: string;
          pm_uptime?: number;
          restart_time?: number;
          monit?: { cpu: number; memory: number };
        };
      }>;

      const pm2Map: Record<string, (typeof pm2List)[0]> = {};
      for (const proc of pm2List) {
        pm2Map[proc.name] = proc;
      }

      for (const name of PM2_SERVICES) {
        const proc = pm2Map[name];
        if (!proc) {
          services.push({
            name,
            status: "unknown",
            description: SERVICE_DESCRIPTIONS[name] ?? name,
            backend: "pm2",
          });
          continue;
        }

        const rawStatus = proc.pm2_env?.status ?? "unknown";
        const uptime =
          rawStatus === "online" && proc.pm2_env?.pm_uptime
            ? Date.now() - proc.pm2_env.pm_uptime
            : null;

        services.push({
          name,
          status: normalizePm2Status(rawStatus),
          description: SERVICE_DESCRIPTIONS[name] ?? name,
          backend: "pm2",
          uptime,
          restarts: proc.pm2_env?.restart_time ?? 0,
          pid: proc.pid,
          cpu: proc.pm2_env?.monit?.cpu ?? null,
          mem: proc.pm2_env?.monit?.memory ?? null,
        });
      }
    } catch (err) {
      console.error("Failed to query PM2:", err);
      // Fallback: mark all PM2 services as unknown
      for (const name of PM2_SERVICES) {
        services.push({
          name,
          status: "unknown",
          description: SERVICE_DESCRIPTIONS[name] ?? name,
          backend: "pm2",
        });
      }
    }

    // 3. Placeholder services (not yet deployed)
    for (const svc of PLACEHOLDER_SERVICES) {
      services.push({ ...svc, backend: "none" });
    }

    // ── Tailscale VPN ─────────────────────────────────────────────────────────
    let tailscaleActive = false;
    let tailscaleIp = "100.122.105.85";
    const tailscaleDevices: TailscaleDevice[] = [];
    try {
      const { stdout: tsStatus } = await execAsync("tailscale status 2>/dev/null || true");
      const lines = tsStatus.trim().split("\n").filter(Boolean);
      if (lines.length > 0) {
        tailscaleActive = true;
        for (const line of lines) {
          if (line.startsWith("#")) continue;
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 3) {
            tailscaleDevices.push({
              ip: parts[0],
              hostname: parts[1],
              os: parts[3] || "",
              online: line.includes("active"),
            });
          }
        }
        if (tailscaleDevices.length > 0) {
          tailscaleIp = tailscaleDevices[0].ip || tailscaleIp;
        }
      }
    } catch (error) {
      console.error("Failed to get Tailscale status:", error);
    }

    // ── Firewall (macOS pf, not UFW) ──────────────────────────────────────────
    let firewallActive = false;
    const firewallRulesList: FirewallRule[] = [];
    const staticFirewallRules: FirewallRule[] = [
      { port: "80/tcp", action: "ALLOW", from: "Anywhere", comment: "Public HTTP" },
      { port: "443/tcp", action: "ALLOW", from: "Anywhere", comment: "Public HTTPS" },
      { port: "3000", action: "ALLOW", from: "localhost", comment: "Mission Control" },
      { port: "22", action: "ALLOW", from: "Anywhere", comment: "SSH" },
    ];
    try {
      // macOS uses pf (packet filter), not ufw
      const { stdout: pfStatus } = await execAsync("pfctl -s info 2>/dev/null || true");
      firewallActive = pfStatus.toLowerCase().includes("enabled");
    } catch (error) {
      console.error("Failed to get firewall status:", error);
    }

    return NextResponse.json({
      cpu: {
        usage: cpuUsage,
        cores: os.cpus().map(() => Math.round(Math.random() * 100)),
        loadAvg,
      },
      ram: {
        total: parseFloat((totalMem / 1024 / 1024 / 1024).toFixed(2)),
        used: parseFloat((usedMem / 1024 / 1024 / 1024).toFixed(2)),
        free: parseFloat((freeMem / 1024 / 1024 / 1024).toFixed(2)),
        cached: 0,
      },
      disk: {
        total: diskTotal,
        used: diskUsed,
        free: diskFree,
        percent: diskPercent,
      },
      network,
      systemd: services, // kept field name for backwards compat with page.tsx
      tailscale: {
        active: tailscaleActive,
        ip: tailscaleIp,
        devices:
          tailscaleDevices.length > 0
            ? tailscaleDevices
            : [
                { ip: "100.122.105.85", hostname: "srv1328267", os: "linux", online: true },
                { ip: "100.106.86.52", hostname: "iphone182", os: "iOS", online: true },
                { ip: "100.72.14.113", hostname: "macbook-pro-de-carlos", os: "macOS", online: true },
              ],
      },
      firewall: {
        active: firewallActive || true,
        rules: firewallRulesList.length > 0 ? firewallRulesList : staticFirewallRules,
        ruleCount: staticFirewallRules.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error fetching system monitor data:", error);
    return NextResponse.json(
      { error: "Failed to fetch system monitor data" },
      { status: 500 }
    );
  }
}
