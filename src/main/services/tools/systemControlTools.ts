import type { ToolSpec } from './ToolRegistry'
import { runPs } from './fileTools'

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

async function toggleRadio(
  kind: 'WiFi' | 'Bluetooth',
  state: string,
  label: string
): Promise<string> {
  const action = state === 'on' ? 'On' : state === 'off' ? 'Off' : 'Toggle'
  const out = await runPs(radioScript(kind, action), 20_000)
  const line = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''
  if (line.startsWith('OK:')) return line.slice(3).trim()
  throw new Error(line.replace(/^ERR:\s*/, '') || `Couldn't change ${label}`)
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
          'Turn the PC\'s Wi-Fi radio on or off (or toggle it) — same as the Action Center Wi-Fi button. Use for "turn on/off wifi", "disable wireless". Note: turning Wi-Fi off drops any internet connection on this machine.',
        inputSchema: {
          type: 'object',
          properties: { state: { type: 'string', enum: ['on', 'off', 'toggle'] } },
          required: ['state']
        },
        sensitive: false
      },
      summary: (a) => `wifi ${String(a.state ?? '')}`,
      run: (a) => toggleRadio('WiFi', String(a.state), 'Wi-Fi')
    },
    {
      def: {
        name: 'bluetooth',
        description:
          'Turn Bluetooth on or off (or toggle it) — same as the Action Center Bluetooth button. Use for "turn on/off bluetooth", "enable bluetooth".',
        inputSchema: {
          type: 'object',
          properties: { state: { type: 'string', enum: ['on', 'off', 'toggle'] } },
          required: ['state']
        },
        sensitive: false
      },
      summary: (a) => `bluetooth ${String(a.state ?? '')}`,
      run: (a) => toggleRadio('Bluetooth', String(a.state), 'Bluetooth')
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
