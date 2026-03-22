import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import os from "os";

const execAsync = promisify(exec);

const SYSTEMD_SERVICES = ["mission-control", "content-vault", "classvault", "creatoros"];

export async function GET() {
  try {
    // CPU (load average as percentage)
    const loadAvg = os.loadavg()[0];
    const cpuCount = os.cpus().length;
    const cpu = Math.min(Math.round((loadAvg / cpuCount) * 100), 100);

    // RAM
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const ram = {
      used: parseFloat((usedMem / 1024 / 1024 / 1024).toFixed(2)),
      total: parseFloat((totalMem / 1024 / 1024 / 1024).toFixed(2)),
    };

    // Disk
    let diskUsed = 0;
    let diskTotal = 100;
    try {
      // Use df -k (KB) for cross-platform compatibility (macOS + Linux)
      const { stdout } = await execAsync("df -k / | tail -1");
      const parts = stdout.trim().split(/\s+/);
      diskTotal = Math.round(parseInt(parts[1]) / 1024 / 1024); // KB -> GB
      diskUsed = Math.round(parseInt(parts[2]) / 1024 / 1024);
    } catch (error) {
      console.error("Failed to get disk stats:", error);
    }

    // Services check — systemd not available on macOS, use PM2 if available
    let activeServices = 0;
    let totalServices = SYSTEMD_SERVICES.length;
    try {
      const { stdout: pm2Out } = await execAsync("pm2 jlist 2>/dev/null");
      const pm2List = JSON.parse(pm2Out) as Array<{ pm2_env?: { status?: string } }>;
      activeServices = pm2List.filter((p) => p.pm2_env?.status === "online").length;
      totalServices = pm2List.length;
    } catch {
      // PM2 not available either — leave defaults
    }

    // Tailscale VPN Status
    let vpnActive = false;
    try {
      const { stdout } = await execAsync("tailscale status 2>/dev/null || true");
      vpnActive = stdout.trim().length > 0 && !stdout.includes("Tailscale is stopped");
    } catch {
      vpnActive = false;
    }

    // Firewall Status — macOS uses pf, not ufw
    let firewallActive = true;
    try {
      const { stdout } = await execAsync("pfctl -s info 2>/dev/null | head -1 || true");
      firewallActive = stdout.toLowerCase().includes("enabled");
    } catch {
      firewallActive = true; // Assume active as default
    }

    // Uptime
    const uptimeSeconds = os.uptime();
    const days = Math.floor(uptimeSeconds / 86400);
    const hours = Math.floor((uptimeSeconds % 86400) / 3600);
    const uptime = `${days}d ${hours}h`;

    return NextResponse.json({
      cpu,
      ram,
      disk: { used: diskUsed, total: diskTotal },
      vpnActive,
      firewallActive,
      activeServices,
      totalServices,
      uptime,
    });
  } catch (error) {
    console.error("Error fetching system stats:", error);
    return NextResponse.json(
      { error: "Failed to fetch system stats" },
      { status: 500 }
    );
  }
}
