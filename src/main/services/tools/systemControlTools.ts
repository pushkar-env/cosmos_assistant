import type { ToolSpec } from './ToolRegistry'
import { runPs, psQuote } from './fileTools'

/**
 * System maintenance + hardware control tools: disk cleanup, recycle bin,
 * Wi-Fi / Bluetooth radios, precise sound, and display brightness. Each is a
 * small, single-purpose tool with a concrete description so both frontier and
 * local (Ollama) models pick the right one from a plain-language request.
 */

// ── Wi-Fi / Bluetooth via the WinRT Radio API ─────────────────────────────
// Same mechanism as the Action Center quick toggles — no admin required.
function radioScript(kind: 'WiFi' | 'Bluetooth', action: 'On' | 'Off' | 'Toggle'): string {
  return `
$ErrorActionPreference='Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $null=[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime]
  $null=[Windows.Devices.Radios.RadioAccessStatus,Windows.System.Devices,ContentType=WindowsRuntime]
  $null=[Windows.Devices.Radios.RadioState,Windows.System.Devices,ContentType=WindowsRuntime]
  $asTask=([System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object{$_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'})[0]
  function Await($op,$t){ $g=$asTask.MakeGenericMethod($t); $tk=$g.Invoke($null,@($op)); $tk.Wait(-1)|Out-Null; $tk.Result }
  $access = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
  if ("$access" -ne 'Allowed') { Write-Output "ERR: radio access denied ($access)"; return }
  $radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
  $r = $radios | Where-Object { $_.Kind -eq '${kind}' } | Select-Object -First 1
  if (-not $r) { Write-Output "ERR: no ${kind} radio found on this PC"; return }
  $target = '${action}'
  if ($target -eq 'Toggle') { if ($r.State -eq 'On') { $target = 'Off' } else { $target = 'On' } }
  if ($r.State -eq $target) { Write-Output "OK: ${kind} already $target"; return }
  $state = [Enum]::Parse([Windows.Devices.Radios.RadioState], $target)
  $res = Await ($r.SetStateAsync($state)) ([Windows.Devices.Radios.RadioAccessStatus])
  if ("$res" -eq 'Allowed') { Write-Output "OK: ${kind} turned $target" } else { Write-Output "ERR: ${kind} change refused ($res)" }
} catch { Write-Output ("ERR: " + $_.Exception.Message) }`
}

/**
 * Set (or toggle) a radio and report whether it ended up ON. Callers use `on`
 * to decide whether to follow up with a connect step — turning the radio on is
 * only half of "turn on my Wi-Fi/Bluetooth"; the user expects to be reconnected.
 */
async function setRadio(
  kind: 'WiFi' | 'Bluetooth',
  state: string
): Promise<{ message: string; on: boolean }> {
  const action = state === 'on' ? 'On' : state === 'off' ? 'Off' : 'Toggle'
  const out = await runPs(radioScript(kind, action), 20_000)
  const line = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  if (!line.startsWith('OK:')) {
    throw new Error(line.replace(/^ERR:\s*/, '') || `Couldn't change ${kind}`)
  }
  const message = line.slice(3).trim() // e.g. "WiFi turned On" / "Bluetooth already Off"
  return { message, on: /\bOn$/i.test(message) }
}

// ── Wi-Fi: connect to a network once the radio is on ──────────────────────
// Enabling the radio does not reliably make Windows re-join a network, so after
// turning Wi-Fi on we connect explicitly: to the SSID the user named if one was
// given, otherwise to the best saved profile that is currently in range (which
// honours the user's own Windows network priority order). Everything is read
// back from `netsh wlan show interfaces` so we only report a connection that
// actually landed — never a claim that didn't happen.
async function connectWifi(ssid: string): Promise<string> {
  const target = ssid ? psQuote(ssid) : "''"
  const script = `
$ErrorActionPreference='SilentlyContinue'
$target = ${target}
function CurrentSsid {
  $o = netsh wlan show interfaces
  $st = ''
  foreach ($l in ($o -split "\`n")) { if ($l -match '^\\s*State\\s*:\\s*(.+?)\\s*$') { $st = $Matches[1] } }
  if ($st -match '^connected$') {
    foreach ($l in ($o -split "\`n")) { if ($l -match '^\\s*SSID\\s*:\\s*(.+?)\\s*$') { return $Matches[1].Trim() } }
  }
  return ''
}
for ($i=0; $i -lt 12; $i++) {
  $iface = netsh wlan show interfaces
  if ($iface -notmatch 'no wireless interface' -and $iface -match 'State\\s*:') { break }
  Start-Sleep -Milliseconds 500
}
$cur = CurrentSsid
if (-not $target -and $cur) { Write-Output "CONN:$cur"; return }
$profiles = @()
foreach ($l in ((netsh wlan show profiles) -split "\`n")) { if ($l -match 'User Profile\\s*:\\s*(.+?)\\s*$') { $profiles += $Matches[1].Trim() } }
$inrange = @()
foreach ($l in ((netsh wlan show networks) -split "\`n")) { if ($l -match '^\\s*SSID\\s+\\d+\\s*:\\s*(.*?)\\s*$') { $inrange += $Matches[1].Trim() } }
if ($target) { $pick = $target } else {
  $pick = $null
  foreach ($p in $profiles) { if ($inrange -contains $p) { $pick = $p; break } }
  if (-not $pick -and $profiles.Count -gt 0) { $pick = $profiles[0] }
}
if (-not $pick) { Write-Output 'NONE'; return }
netsh wlan connect ('name=' + $pick) | Out-Null
for ($i=0; $i -lt 16; $i++) { Start-Sleep -Milliseconds 500; $cur = CurrentSsid; if ($cur) { break } }
if ($cur) { Write-Output "CONN:$cur" } else { Write-Output "FAIL:$pick" }`
  const out = (await runPs(script, 30_000)).trim()
  const line = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  if (line.startsWith('CONN:')) return `Wi-Fi is on and connected to ${line.slice(5).trim()}.`
  if (line === 'NONE') {
    return "Wi-Fi is on, but there are no saved networks in range to join. Connect to one once from the Wi-Fi menu and I'll rejoin it automatically next time."
  }
  if (line.startsWith('FAIL:')) {
    return `Wi-Fi is on, but I couldn't connect to ${line.slice(5).trim()} — it may be out of range or its saved password changed.`
  }
  return 'Wi-Fi is on.'
}

// ── Precise master volume via CoreAudio (IAudioEndpointVolume) ─────────────
const AUDIO_CSHARP = `
using System;
using System.Runtime.InteropServices;
namespace CosmosAudio {
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr n); int UnregisterControlChangeNotify(IntPtr n);
    int GetChannelCount(out uint c);
    int SetMasterVolumeLevel(float l, ref Guid e); int SetMasterVolumeLevelScalar(float l, ref Guid e);
    int GetMasterVolumeLevel(out float l); int GetMasterVolumeLevelScalar(out float l);
    int SetChannelVolumeLevel(uint i, float l, ref Guid e); int SetChannelVolumeLevelScalar(uint i, float l, ref Guid e);
    int GetChannelVolumeLevel(uint i, out float l); int GetChannelVolumeLevelScalar(uint i, out float l);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid e); int GetMute(out bool m);
    int GetVolumeStepInfo(out uint s, out uint c); int VolumeStepUp(ref Guid e); int VolumeStepDown(ref Guid e);
    int QueryHardwareSupport(out uint m); int GetVolumeRange(out float min, out float max, out float inc);
  }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int NotImpl1(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ep); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
  public static class Vol {
    static IAudioEndpointVolume Endpoint() {
      var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
      IMMDevice dev; e.GetDefaultAudioEndpoint(0, 1, out dev);
      Guid iid = typeof(IAudioEndpointVolume).GUID; object o; dev.Activate(ref iid, 1, IntPtr.Zero, out o);
      return (IAudioEndpointVolume)o;
    }
    public static float Get() { float v; Endpoint().GetMasterVolumeLevelScalar(out v); return v; }
    public static bool Muted() { bool m; Endpoint().GetMute(out m); return m; }
    public static void Set(float v) { Guid g = Guid.Empty; Endpoint().SetMasterVolumeLevelScalar(v, ref g); }
    public static void Mute(bool m) { Guid g = Guid.Empty; Endpoint().SetMute(m, ref g); }
  }
}`

function soundScript(body: string): string {
  return `$ErrorActionPreference='Stop'
$code = @'${AUDIO_CSHARP}
'@
Add-Type -TypeDefinition $code
try { ${body} } catch { Write-Output ("ERR: " + $_.Exception.Message) }`
}

// ── Bluetooth: reconnect a paired device via the Win32 Bluetooth API ───────
// Turning the radio on doesn't reconnect a device on its own. We enumerate the
// paired devices with BluetoothFindFirstDevice/Next, pick the target (the name
// the user gave, else the most recently used one), and call BluetoothSetService
// State(ENABLE) on each of its installed services to ask Windows to connect it.
// Same class of non-admin interop as the audio COM code above. It is best-effort
// by nature: some devices (and some device classes) only reconnect when the
// device itself is powered on and initiates, so we phrase the result honestly.
const BT_CSHARP = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace CosmosBt {
  [StructLayout(LayoutKind.Sequential)]
  public struct SYSTEMTIME { public ushort Year, Month, DayOfWeek, Day, Hour, Minute, Second, Milliseconds; }
  [StructLayout(LayoutKind.Sequential)]
  public struct BLUETOOTH_DEVICE_SEARCH_PARAMS {
    public uint dwSize;
    [MarshalAs(UnmanagedType.Bool)] public bool fReturnAuthenticated;
    [MarshalAs(UnmanagedType.Bool)] public bool fReturnRemembered;
    [MarshalAs(UnmanagedType.Bool)] public bool fReturnUnknown;
    [MarshalAs(UnmanagedType.Bool)] public bool fReturnConnected;
    [MarshalAs(UnmanagedType.Bool)] public bool fIssueInquiry;
    public byte cTimeoutMultiplier;
    public IntPtr hRadio;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct BLUETOOTH_DEVICE_INFO {
    public uint dwSize;
    public ulong Address;
    public uint ulClassofDevice;
    [MarshalAs(UnmanagedType.Bool)] public bool fConnected;
    [MarshalAs(UnmanagedType.Bool)] public bool fRemembered;
    [MarshalAs(UnmanagedType.Bool)] public bool fAuthenticated;
    public SYSTEMTIME stLastSeen;
    public SYSTEMTIME stLastUsed;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 248)] public string szName;
  }
  public static class Bt {
    [DllImport("bthprops.cpl", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr BluetoothFindFirstDevice(ref BLUETOOTH_DEVICE_SEARCH_PARAMS p, ref BLUETOOTH_DEVICE_INFO info);
    [DllImport("bthprops.cpl", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool BluetoothFindNextDevice(IntPtr h, ref BLUETOOTH_DEVICE_INFO info);
    [DllImport("bthprops.cpl", SetLastError = true)]
    static extern bool BluetoothFindDeviceClose(IntPtr h);
    [DllImport("bthprops.cpl", SetLastError = true)]
    static extern uint BluetoothEnumerateInstalledServices(IntPtr hRadio, ref BLUETOOTH_DEVICE_INFO info, ref uint num, [In, Out] Guid[] services);
    [DllImport("bthprops.cpl", SetLastError = true)]
    static extern uint BluetoothSetServiceState(IntPtr hRadio, ref BLUETOOTH_DEVICE_INFO info, ref Guid service, uint state);

    static BLUETOOTH_DEVICE_INFO NewInfo() {
      var i = new BLUETOOTH_DEVICE_INFO();
      i.dwSize = (uint)Marshal.SizeOf(typeof(BLUETOOTH_DEVICE_INFO));
      return i;
    }
    static long Rank(SYSTEMTIME s) {
      return ((((((long)s.Year * 13 + s.Month) * 32 + s.Day) * 25 + s.Hour) * 61 + s.Minute) * 61 + s.Second);
    }
    public static string Connect(string nameFilter) {
      var sp = new BLUETOOTH_DEVICE_SEARCH_PARAMS();
      sp.dwSize = (uint)Marshal.SizeOf(typeof(BLUETOOTH_DEVICE_SEARCH_PARAMS));
      sp.fReturnAuthenticated = true; sp.fReturnRemembered = true; sp.fReturnConnected = true;
      sp.fReturnUnknown = false; sp.fIssueInquiry = false; sp.cTimeoutMultiplier = 2; sp.hRadio = IntPtr.Zero;
      var info = NewInfo();
      IntPtr h = BluetoothFindFirstDevice(ref sp, ref info);
      if (h == IntPtr.Zero) return "ERR:no paired Bluetooth devices found — pair one in Windows Settings first";
      var list = new List<BLUETOOTH_DEVICE_INFO>();
      do { if (info.fRemembered || info.fAuthenticated) list.Add(info); info = NewInfo(); }
      while (BluetoothFindNextDevice(h, ref info));
      BluetoothFindDeviceClose(h);
      if (list.Count == 0) return "ERR:no paired Bluetooth devices found — pair one in Windows Settings first";
      int idx = -1;
      if (!string.IsNullOrEmpty(nameFilter)) {
        for (int i = 0; i < list.Count; i++) {
          string nm = (list[i].szName ?? "").Trim();
          if (nm.IndexOf(nameFilter, StringComparison.OrdinalIgnoreCase) >= 0) { if (idx < 0 || list[i].fConnected) idx = i; }
        }
        if (idx < 0) return "ERR:no paired device named '" + nameFilter + "' — say the exact name shown in Windows";
      } else {
        long best = -1;
        for (int i = 0; i < list.Count; i++) { long t = Rank(list[i].stLastUsed); if (t > best) { best = t; idx = i; } }
      }
      var target = list[idx];
      string name = (target.szName ?? "").Trim(); if (name.Length == 0) name = "the device";
      if (target.fConnected) return "OK:" + name + " is already connected";
      uint n = 0;
      BluetoothEnumerateInstalledServices(IntPtr.Zero, ref target, ref n, null);
      if (n == 0) return "WARN:" + name + " exposes no connectable services";
      Guid[] guids = new Guid[n];
      uint res = BluetoothEnumerateInstalledServices(IntPtr.Zero, ref target, ref n, guids);
      if (res != 0) return "ERR:couldn't read Bluetooth services for " + name;
      int ok = 0;
      for (int i = 0; i < guids.Length; i++) { Guid g = guids[i]; if (BluetoothSetServiceState(IntPtr.Zero, ref target, ref g, 0x00000001) == 0) ok++; }
      if (ok == 0) return "ERR:couldn't start a connection to " + name;
      return "OK:connecting to " + name;
    }
  }
}`

function btScript(body: string): string {
  return `$ErrorActionPreference='Stop'
$code = @'${BT_CSHARP}
'@
Add-Type -TypeDefinition $code
try { ${body} } catch { Write-Output ("ERR:" + $_.Exception.Message) }`
}

async function connectBluetooth(name: string): Promise<string> {
  const filter = name ? psQuote(name) : "''"
  const body = `Start-Sleep -Milliseconds 800
Write-Output ([CosmosBt.Bt]::Connect(${filter}))`
  const out = (await runPs(btScript(body), 30_000)).trim()
  const line = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  const rest = line.replace(/^(OK|ERR|WARN):/, '').trim()
  if (line.startsWith('OK:')) return `Bluetooth is on — ${rest}.`
  if (line.startsWith('WARN:') || line.startsWith('ERR:')) return `Bluetooth is on, but ${rest}.`
  return `Bluetooth is on.${line ? ' ' + line : ''}`
}

export function systemControlTools(): ToolSpec[] {
  return [
    {
      def: {
        name: 'system_cleanup',
        description:
          'Free up disk space and speed up the PC by clearing safe junk: user + Windows temp files, the Windows Update download cache, internet cache, crash dumps, error reports, and thumbnail/icon caches. Reports how much space was reclaimed per location. Set emptyRecycleBin:true to also empty the Recycle Bin. Use for "clean my PC", "clear temp files", "free up space", "speed up my computer".',
        inputSchema: {
          type: 'object',
          properties: {
            emptyRecycleBin: {
              type: 'boolean',
              description: 'Also empty the Recycle Bin as part of the cleanup (default false).'
            }
          }
        },
        sensitive: true
      },
      summary: (a) => (a.emptyRecycleBin ? 'clean junk + recycle bin' : 'clean temp/junk files'),
      run: async (a) => {
        const emptyRb = a.emptyRecycleBin === true ? 'yes' : 'no'
        const script = `
$ErrorActionPreference='SilentlyContinue'
function Clean($name, $path, $filter) {
  if (-not (Test-Path -LiteralPath $path)) { return [pscustomobject]@{ name=$name; freedMB=0 } }
  $before = (Get-ChildItem -LiteralPath $path -Recurse -Force | Measure-Object -Property Length -Sum).Sum
  if ($filter) { Get-ChildItem -LiteralPath $path -Force -Filter $filter | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
  else { Get-ChildItem -LiteralPath $path -Force | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
  $after = (Get-ChildItem -LiteralPath $path -Recurse -Force | Measure-Object -Property Length -Sum).Sum
  $d = [int64]$before - [int64]$after; if ($d -lt 0) { $d = 0 }
  [pscustomobject]@{ name=$name; freedMB=[math]::Round($d/1MB, 1) }
}
$r = @()
$r += Clean 'User temp' $env:TEMP $null
$r += Clean 'Windows temp' "$env:SystemRoot\\Temp" $null
$r += Clean 'Internet cache' "$env:LOCALAPPDATA\\Microsoft\\Windows\\INetCache" $null
$r += Clean 'Windows Update cache' "$env:SystemRoot\\SoftwareDistribution\\Download" $null
$r += Clean 'Crash dumps' "$env:LOCALAPPDATA\\CrashDumps" $null
$r += Clean 'Error reports' "$env:LOCALAPPDATA\\Microsoft\\Windows\\WER" $null
$r += Clean 'Thumbnail cache' "$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer" 'thumbcache_*.db'
$r += Clean 'Icon cache' "$env:LOCALAPPDATA\\Microsoft\\Windows\\Explorer" 'iconcache_*.db'
$rbCount = -1
if ('${emptyRb}' -eq 'yes') {
  $rb = (New-Object -ComObject Shell.Application).Namespace(0xA); $rbCount = $rb.Items().Count
  Clear-RecycleBin -Force -ErrorAction SilentlyContinue
}
$total = ($r | Measure-Object -Property freedMB -Sum).Sum
[pscustomobject]@{ total=$total; recycleBin=$rbCount; items=$r } | ConvertTo-Json -Compress`
        const out = await runPs(script, 150_000)
        let data: { total?: number; recycleBin?: number; items?: { name: string; freedMB: number }[] }
        try {
          data = JSON.parse(out)
        } catch {
          return out || 'Cleanup finished.'
        }
        const items = (data.items ?? []).filter((i) => i.freedMB > 0)
        const fmt = (mb: number): string => (mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(1)} MB`)
        const lines = items.map((i) => `  • ${i.name}: ${fmt(i.freedMB)}`)
        if (typeof data.recycleBin === 'number' && data.recycleBin >= 0) {
          lines.push(`  • Recycle Bin: emptied (${data.recycleBin} item${data.recycleBin === 1 ? '' : 's'})`)
        }
        const total = data.total ?? 0
        return lines.length
          ? `Cleaned up and reclaimed ~${fmt(total)}:\n${lines.join('\n')}`
          : 'Everything was already clean — no significant junk to remove.'
      }
    },
    {
      def: {
        name: 'recycle_bin_empty',
        description:
          'Permanently empty the Windows Recycle Bin across all drives (this cannot be undone). Use for "empty the recycle bin", "clear the trash".',
        inputSchema: { type: 'object', properties: {} },
        sensitive: true
      },
      summary: () => 'empty recycle bin',
      run: async () => {
        const out = await runPs(
          `$rb=(New-Object -ComObject Shell.Application).Namespace(0xA); $n=$rb.Items().Count; Clear-RecycleBin -Force -ErrorAction SilentlyContinue; Write-Output $n`,
          30_000
        )
        const n = parseInt(out.trim(), 10)
        if (!Number.isFinite(n) || n <= 0) return 'The Recycle Bin was already empty.'
        return `Emptied the Recycle Bin (${n} item${n === 1 ? '' : 's'} permanently removed).`
      }
    },
    {
      def: {
        name: 'wifi',
        description:
          'Turn the PC\'s Wi-Fi radio on or off (or toggle it). When turning it ON, Cosmos also gets back online: it joins the network named in `network` if given, otherwise the best saved network in range — so "turn on wifi" reconnects automatically instead of just enabling the radio. Use for "turn on/off wifi", "connect to <name> wifi", "disable wireless". Turning Wi-Fi off drops any internet connection on this machine.',
        inputSchema: {
          type: 'object',
          properties: {
            state: { type: 'string', enum: ['on', 'off', 'toggle'] },
            network: {
              type: 'string',
              description:
                'Optional Wi-Fi network name (SSID) to join when turning Wi-Fi on. Omit to auto-connect to the best saved network in range.'
            }
          },
          required: ['state']
        },
        sensitive: false
      },
      summary: (a) => (a.network ? `wifi on → ${String(a.network)}` : `wifi ${String(a.state ?? '')}`),
      run: async (a) => {
        const r = await setRadio('WiFi', String(a.state))
        if (!r.on) {
          return r.message.toLowerCase().includes('already') ? 'Wi-Fi is already off.' : 'Wi-Fi turned off.'
        }
        return connectWifi(typeof a.network === 'string' ? a.network.trim() : '')
      }
    },
    {
      def: {
        name: 'bluetooth',
        description:
          'Turn Bluetooth on or off (or toggle it). When turning it ON, Cosmos also reconnects a paired device: the one named in `device` if given, otherwise the most recently used one (headset, speaker, mouse…) — so "turn on bluetooth" gets your device back rather than just enabling the radio. Best-effort: some devices only reconnect when they are powered on and initiate themselves. Use for "turn on/off bluetooth", "connect my headphones".',
        inputSchema: {
          type: 'object',
          properties: {
            state: { type: 'string', enum: ['on', 'off', 'toggle'] },
            device: {
              type: 'string',
              description:
                'Optional paired device name to connect when turning Bluetooth on (matches any part of the name). Omit to reconnect the most recently used device.'
            }
          },
          required: ['state']
        },
        sensitive: false
      },
      summary: (a) =>
        a.device ? `bluetooth on → ${String(a.device)}` : `bluetooth ${String(a.state ?? '')}`,
      run: async (a) => {
        const r = await setRadio('Bluetooth', String(a.state))
        if (!r.on) {
          return r.message.toLowerCase().includes('already')
            ? 'Bluetooth is already off.'
            : 'Bluetooth turned off.'
        }
        return connectBluetooth(typeof a.device === 'string' ? a.device.trim() : '')
      }
    },
    {
      def: {
        name: 'sound',
        description:
          'Control the system master volume precisely. actions: "set" (exact level 0-100 via percent), "up"/"down" (by steps, ~2% each), "mute", "unmute", "status" (report current level + mute). Use for "set volume to 30", "turn it up", "mute", "how loud is it".',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['set', 'up', 'down', 'mute', 'unmute', 'status'] },
            percent: { type: 'number', description: 'Target level 0-100 (for action "set").' },
            steps: { type: 'number', description: 'Steps for up/down (default 5, each ~2%).' }
          },
          required: ['action']
        },
        sensitive: false
      },
      summary: (a) =>
        a.action === 'set' ? `volume → ${Number(a.percent)}%` : `volume ${String(a.action ?? '')}`,
      run: async (a) => {
        const action = String(a.action)
        // Every branch measures the level BEFORE and AFTER the change and
        // reports the REAL resulting level (read back from the endpoint), so
        // the model can never claim a change that didn't actually land.
        let mutate = ''
        if (action === 'set') {
          const pct = Math.min(Math.max(Number(a.percent) || 0, 0), 100)
          mutate = `[CosmosAudio.Vol]::Set(${(pct / 100).toFixed(3)}); if (${pct} -gt 0) { [CosmosAudio.Vol]::Mute($false) }`
        } else if (action === 'mute') {
          mutate = `[CosmosAudio.Vol]::Mute($true)`
        } else if (action === 'unmute') {
          mutate = `[CosmosAudio.Vol]::Mute($false)`
        } else if (action === 'up' || action === 'down') {
          const steps = Math.min(Math.max(Number(a.steps) || 5, 1), 50)
          const delta = (action === 'up' ? 1 : -1) * 0.02 * steps
          // NB: 0.0/1.0 (not 0/1) so [math]::Min/Max keep the double overload —
          // an int literal makes PowerShell round the 0-1 scalar to 0 or 1.
          mutate = `$cur=[double][CosmosAudio.Vol]::Get(); $nv=[math]::Min(1.0,[math]::Max(0.0,$cur+(${delta.toFixed(3)}))); [CosmosAudio.Vol]::Set([float]$nv)`
        }
        const body = `$before=[math]::Round([CosmosAudio.Vol]::Get()*100)
${mutate}
$after=[math]::Round([CosmosAudio.Vol]::Get()*100)
Write-Output ("RES $before $after " + [CosmosAudio.Vol]::Muted())`
        const out = (await runPs(soundScript(body), 20_000)).trim()
        const line = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
        if (line.startsWith('ERR:')) throw new Error(line.slice(4).trim() || 'Volume control failed')
        const m = line.match(/^RES\s+(\d+)\s+(\d+)\s+(True|False)/i)
        if (!m) throw new Error(`Unexpected volume result: ${line}`)
        const before = Number(m[1])
        const after = Number(m[2])
        const muted = /true/i.test(m[3])
        const mutedNote = muted ? ' (currently muted)' : ''
        if (action === 'status') return `Volume is at ${after}%${mutedNote}.`
        if (action === 'mute') return `Muted (volume level ${after}%).`
        if (action === 'unmute') return `Unmuted — volume is at ${after}%.`
        if (before === after) {
          return `Volume was already at ${after}%${
            after === 100 && action === 'up' ? ' (maximum)' : after === 0 && action === 'down' ? ' (minimum)' : ''
          } — no change.${mutedNote}`
        }
        return `Volume ${after < before ? 'decreased' : 'increased'} from ${before}% to ${after}%${mutedNote}.`
      }
    },
    {
      def: {
        name: 'brightness',
        description:
          'Set display brightness. actions: "set" (exact 0-100 via percent) or "up"/"down". Works on laptop panels and DDC-capable monitors; external desktop monitors often do not support software brightness — the result will say so if unsupported. Use for "set brightness to 50", "dim the screen".',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['set', 'up', 'down'] },
            percent: { type: 'number', description: 'Target 0-100 (for "set").' },
            steps: { type: 'number', description: 'Percent to change for up/down (default 10).' }
          },
          required: ['action']
        },
        sensitive: false
      },
      summary: (a) =>
        a.action === 'set' ? `brightness → ${Number(a.percent)}%` : `brightness ${String(a.action ?? '')}`,
      run: async (a) => {
        const action = String(a.action)
        const steps = Math.min(Math.max(Number(a.steps) || 10, 1), 100)
        let target: string
        if (action === 'set') {
          target = String(Math.min(Math.max(Number(a.percent) || 0, 0), 100))
        } else {
          const sign = action === 'up' ? '+' : '-'
          target = `[math]::Min(100,[math]::Max(0,$cur ${sign} ${steps}))`
        }
        const script = `
$ErrorActionPreference='Stop'
try {
  $cur = (Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop).CurrentBrightness
  $t = [int](${target})
  Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Timeout = 1; Brightness = [byte]$t } | Out-Null
  Write-Output "OK $t"
} catch { Write-Output "ERR: this display does not support software brightness control (usually only laptop screens / DDC monitors do)" }`
        const out = (await runPs(script, 15_000)).trim()
        const line = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
        if (line.startsWith('ERR:')) throw new Error(line.slice(4).trim())
        return `Brightness set to ${line.replace(/^OK\s*/, '')}%.`
      }
    }
  ]
}
