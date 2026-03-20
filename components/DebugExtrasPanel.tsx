import React, { useState, useCallback, useEffect } from 'react';
import {
  Package,
  FolderGit2,
  OctagonX,
  Eraser,
  Skull,
  ClipboardList,
  Globe,
  Shield,
  Database,
  Download,
  Zap,
  Layers,
  Loader2,
  Copy,
  Check,
} from 'lucide-react';
import { localAdbService as adbService } from '../services/localAdbService';
import type { DeviceInfo, AppStackInfo, AppEnvInfo } from '../types';

const DEFAULT_GRADLE_APK = 'app/build/outputs/apk/debug/app-debug.apk';

interface DebugExtrasPanelProps {
  connected: boolean;
  packageName?: string;
  device: DeviceInfo | null;
  stackInfo: AppStackInfo | null;
  envInfo: AppEnvInfo | null;
}

/**
 * 扩展调试：安装 APK、Gradle 路径安装、强停/清缓存、诊断拉取、系统代理、权限摘要、
 * run-as 拉取、Monkey、WebView 摘要、Issue 模板复制。
 */
export const DebugExtrasPanel: React.FC<DebugExtrasPanelProps> = ({
  connected,
  packageName,
  device,
  stackInfo,
  envInfo,
}) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [apkFile, setApkFile] = useState<File | null>(null);
  const [gradlePath, setGradlePath] = useState(DEFAULT_GRADLE_APK);
  const [installLog, setInstallLog] = useState<string | null>(null);
  const [proxyCurrent, setProxyCurrent] = useState<string>('');
  const [proxyInput, setProxyInput] = useState('');
  const [permSummary, setPermSummary] = useState<string | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, string> | null>(null);
  const [runAsOut, setRunAsOut] = useState<string | null>(null);
  const [runAsRel, setRunAsRel] = useState('shared_prefs/debug.xml');
  const [monkeyEvents, setMonkeyEvents] = useState(500);
  const [monkeyThrottle, setMonkeyThrottle] = useState(200);
  const [monkeyOut, setMonkeyOut] = useState<string | null>(null);
  const [wvSummary, setWvSummary] = useState<string | null>(null);
  const [issueCopied, setIssueCopied] = useState(false);

  const hasPkg = !!packageName && packageName.length > 2;
  const setBusyKey = (k: string | null) => setBusy(k);

  const refreshProxy = useCallback(async () => {
    if (!connected) return;
    try {
      const p = await adbService.fetchGlobalHttpProxy();
      setProxyCurrent(p || '（空）');
    } catch {
      setProxyCurrent('（读取失败）');
    }
  }, [connected]);

  useEffect(() => {
    void refreshProxy();
  }, [refreshProxy, connected]);

  const handleInstallApk = async () => {
    if (!connected || !apkFile) return;
    setBusyKey('install');
    setInstallLog(null);
    try {
      const r = await adbService.installApkFromFile(apkFile);
      setInstallLog(r.ok ? `成功\n${r.output}` : `未完成成功标记\n${r.output}`);
    } catch (e) {
      setInstallLog(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const handleInstallPath = async () => {
    if (!connected || !gradlePath.trim()) return;
    setBusyKey('installPath');
    setInstallLog(null);
    try {
      const r = await adbService.installApkFromProjectRelativePath(gradlePath.trim());
      setInstallLog(r.ok ? `成功\n${r.output}` : `请查看输出\n${r.output}`);
    } catch (e) {
      setInstallLog(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const handleForceStop = async () => {
    if (!hasPkg) return;
    if (!confirm(`确定强制停止 ${packageName}？`)) return;
    setBusyKey('stop');
    try {
      await adbService.terminateApp(packageName!);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const handleClearCache = async () => {
    if (!hasPkg) return;
    if (!confirm(`仅清除 ${packageName} 的缓存（不清数据）？`)) return;
    setBusyKey('cache');
    try {
      const out = await adbService.clearAppCacheOnly(packageName!);
      window.alert(out || '已执行');
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const handleArtifacts = async () => {
    if (!connected) return;
    setBusyKey('artifacts');
    setArtifacts(null);
    try {
      const parts = await adbService.fetchDebugArtifacts();
      setArtifacts(parts);
    } catch (e) {
      setArtifacts({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyKey(null);
    }
  };

  const handleApplyProxy = async () => {
    if (!connected) return;
    setBusyKey('proxy');
    try {
      const msg = await adbService.setGlobalHttpProxy(proxyInput.trim() || null);
      window.alert(msg);
      void refreshProxy();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const handleClearProxy = async () => {
    if (!connected) return;
    setBusyKey('proxy');
    try {
      await adbService.setGlobalHttpProxy(null);
      window.alert('已清除系统 HTTP 代理');
      setProxyInput('');
      void refreshProxy();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const handlePermissions = async () => {
    if (!hasPkg) return;
    setBusyKey('perm');
    setPermSummary(null);
    try {
      const { summary, truncated } = await adbService.fetchPackagePermissionsSummary(packageName!);
      setPermSummary(summary + (truncated ? '\n\n…（已截断，完整请用 adb dumpsys package）' : ''));
    } catch (e) {
      setPermSummary(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const handleRunAsList = async (kind: 'databases' | 'shared_prefs') => {
    if (!hasPkg) return;
    setBusyKey(`runas-${kind}`);
    setRunAsOut(null);
    try {
      const out = await adbService.listRunAsSubdir(packageName!, kind);
      setRunAsOut(out);
    } catch (e) {
      setRunAsOut(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const handleRunAsDownload = async () => {
    if (!hasPkg || !runAsRel.trim()) return;
    setBusyKey('runas-dl');
    try {
      const blob = await adbService.downloadRunAsFile(packageName!, runAsRel.trim());
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = runAsRel.split('/').pop() || 'file.bin';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const handleMonkey = async () => {
    if (!hasPkg) return;
    if (!confirm(`将对 ${packageName} 运行 Monkey（${monkeyEvents} 事件），可能打乱当前界面，继续？`)) return;
    setBusyKey('monkey');
    setMonkeyOut(null);
    try {
      const out = await adbService.runMonkey(packageName!, monkeyEvents, monkeyThrottle);
      setMonkeyOut(out);
    } catch (e) {
      setMonkeyOut(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const handleWebViewSummary = async () => {
    if (!connected) return;
    setBusyKey('wv');
    setWvSummary(null);
    try {
      const s = await adbService.fetchWebViewSummary(hasPkg ? packageName : undefined);
      setWvSummary(
        `套接字约: ${s.socketCount}，可调试页: ${s.pageCount}，ok=${s.ok}${s.hint ? `\n${s.hint}` : ''}`
      );
    } catch (e) {
      setWvSummary(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const buildIssueMarkdown = (): string => {
    const lines: string[] = ['### 调试环境快照', ''];
    if (device) {
      lines.push(`- **设备**: ${device.name}（${device.model}）`);
      lines.push(`- **序列号**: \`${device.serial}\``);
    }
    if (stackInfo) {
      lines.push(`- **顶层 Activity**: \`${stackInfo.activityName}\``);
      lines.push(`- **包名**: \`${stackInfo.packageName}\``);
    }
    if (envInfo) {
      lines.push(`- **versionName**: ${envInfo.versionName}  **versionCode**: ${envInfo.versionCode}`);
      lines.push(
        `- **环境**: ${envInfo.environment}  **debuggable**: ${envInfo.debuggable}  **系统**: Android ${envInfo.deviceAndroidVersion ?? '-'}（SDK ${envInfo.deviceSdkVersion ?? '-'})`
      );
    }
    lines.push('');
    lines.push('（以下为手动补充）');
    lines.push('');
    lines.push('- **复现步骤**: ');
    lines.push('- **期望 / 实际**: ');
    return lines.join('\n');
  };

  const copyIssue = async () => {
    const md = buildIssueMarkdown();
    try {
      await navigator.clipboard.writeText(md);
      setIssueCopied(true);
      window.setTimeout(() => setIssueCopied(false), 2000);
    } catch {
      window.alert('复制失败，请手动全选复制');
    }
  };

  if (!connected) {
    return (
      <div className="rounded-lg border border-dashed border-slate-800 bg-slate-950/30 p-6 text-center text-xs text-slate-500">
        连接设备后可使用扩展调试（安装 APK、代理、诊断等）
      </div>
    );
  }

  return (
    <div className="space-y-6 border-t border-slate-800 pt-6">
      <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-cyan-500/90">
        <Package size={16} />
        扩展调试
      </h3>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {/* 安装 */}
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
          <h4 className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <Package size={12} /> 安装 APK
          </h4>
          <div className="space-y-2">
            <input
              type="file"
              accept=".apk,application/vnd.android.package-archive"
              className="w-full text-[10px] text-slate-400 file:mr-2 file:rounded file:border-0 file:bg-slate-800 file:px-2 file:py-1 file:text-xs"
              onChange={(e) => setApkFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              disabled={!!busy || !apkFile}
              onClick={() => void handleInstallApk()}
              className="flex w-full items-center justify-center gap-2 rounded border border-slate-700 bg-slate-900 py-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
            >
              {busy === 'install' ? <Loader2 size={14} className="animate-spin" /> : null}
              上传并安装（-r）
            </button>
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
          <h4 className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <FolderGit2 size={12} /> 从项目相对路径安装
          </h4>
          <p className="mb-2 text-[10px] leading-relaxed text-slate-500">
            桥接进程 cwd 一般为项目根；用于 Gradle 输出 APK，勿用 .. 穿越目录。
          </p>
          <input
            value={gradlePath}
            onChange={(e) => setGradlePath(e.target.value)}
            className="mb-2 w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-[11px] text-cyan-300"
          />
          <button
            type="button"
            disabled={!!busy || !gradlePath.trim()}
            onClick={() => void handleInstallPath()}
            className="flex w-full items-center justify-center gap-2 rounded border border-slate-700 bg-slate-900 py-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            {busy === 'installPath' ? <Loader2 size={14} className="animate-spin" /> : null}
            安装该路径 APK
          </button>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
          <h4 className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <OctagonX size={12} /> 应用进程
          </h4>
          <div className="space-y-2">
            <button
              type="button"
              disabled={!!busy || !hasPkg}
              onClick={() => void handleForceStop()}
              className="flex w-full items-center gap-2 rounded border border-red-900/50 bg-red-950/20 py-2 pl-3 text-xs text-red-200 hover:bg-red-950/40 disabled:opacity-40"
            >
              {busy === 'stop' ? <Loader2 size={14} className="animate-spin" /> : <OctagonX size={14} />}
              强制停止当前包
            </button>
            <button
              type="button"
              disabled={!!busy || !hasPkg}
              onClick={() => void handleClearCache()}
              className="flex w-full items-center gap-2 rounded border border-amber-900/40 bg-amber-950/15 py-2 pl-3 text-xs text-amber-100 hover:bg-amber-950/30 disabled:opacity-40"
            >
              {busy === 'cache' ? <Loader2 size={14} className="animate-spin" /> : <Eraser size={14} />}
              仅清缓存（不清数据）
            </button>
          </div>
        </div>

        {/* 诊断 */}
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4 md:col-span-2">
          <h4 className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <Skull size={12} /> 崩溃 / ANR 线索
          </h4>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void handleArtifacts()}
            className="mb-2 flex items-center gap-2 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            {busy === 'artifacts' ? <Loader2 size={14} className="animate-spin" /> : <Skull size={14} />}
            拉取 ANR 目录 / tombstone 抽样 / crash buffer / dropbox 尾部
          </button>
          {artifacts && (
            <div className="max-h-56 space-y-2 overflow-y-auto rounded border border-slate-800 bg-slate-950 p-2">
              {Object.entries(artifacts).map(([k, v]) => (
                <details key={k} className="text-[10px]">
                  <summary className="cursor-pointer font-mono text-cyan-600">{k}</summary>
                  <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-slate-400">{v}</pre>
                </details>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
          <h4 className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <ClipboardList size={12} /> Issue 模板
          </h4>
          <button
            type="button"
            onClick={() => void copyIssue()}
            className="flex w-full items-center justify-center gap-2 rounded border border-slate-700 bg-slate-900 py-2 text-xs text-slate-200 hover:bg-slate-800"
          >
            {issueCopied ? <Check size={14} className="text-emerald-400" /> : <Copy size={14} />}
            {issueCopied ? '已复制 Markdown' : '复制环境快照（飞书/Jira）'}
          </button>
        </div>

        {/* 代理 */}
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4 xl:col-span-2">
          <h4 className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <Globe size={12} /> 全局 HTTP 代理（settings global http_proxy）
          </h4>
          <p className="mb-2 font-mono text-[10px] text-slate-400">当前：{proxyCurrent}</p>
          <div className="flex flex-wrap gap-2">
            <input
              value={proxyInput}
              onChange={(e) => setProxyInput(e.target.value)}
              placeholder="192.168.1.2:8888"
              className="min-w-[10rem] flex-1 rounded border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs text-cyan-300"
            />
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void handleApplyProxy()}
              className="rounded border border-cyan-800 bg-cyan-950/40 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-950/60 disabled:opacity-50"
            >
              {busy === 'proxy' ? <Loader2 size={14} className="animate-spin" /> : null}
              应用
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void handleClearProxy()}
              className="rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              清除
            </button>
            <button
              type="button"
              onClick={() => void refreshProxy()}
              className="rounded border border-slate-700 px-3 py-1.5 text-xs text-slate-400 hover:bg-slate-800"
            >
              刷新
            </button>
          </div>
        </div>

        {/* 权限 */}
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4 xl:col-span-3">
          <h4 className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <Shield size={12} /> 权限摘要（dumpsys package 过滤）
          </h4>
          <button
            type="button"
            disabled={!!busy || !hasPkg}
            onClick={() => void handlePermissions()}
            className="mb-2 rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40"
          >
            {busy === 'perm' ? <Loader2 size={14} className="inline animate-spin" /> : null}
            拉取当前包权限相关行
          </button>
          {permSummary && (
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded border border-slate-800 bg-slate-950 p-2 text-[10px] text-slate-400">
              {permSummary}
            </pre>
          )}
        </div>

        {/* run-as */}
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4 xl:col-span-2">
          <h4 className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <Database size={12} /> run-as 数据（需 debuggable）
          </h4>
          <div className="mb-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!!busy || !hasPkg}
              onClick={() => void handleRunAsList('databases')}
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-[10px] text-slate-300 disabled:opacity-40"
            >
              列出 databases
            </button>
            <button
              type="button"
              disabled={!!busy || !hasPkg}
              onClick={() => void handleRunAsList('shared_prefs')}
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-[10px] text-slate-300 disabled:opacity-40"
            >
              列出 shared_prefs
            </button>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label className="mb-0.5 block text-[10px] text-slate-500">相对路径下载</label>
              <input
                value={runAsRel}
                onChange={(e) => setRunAsRel(e.target.value)}
                placeholder="databases/app.db 或 shared_prefs/x.xml"
                className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-[11px] text-cyan-300"
              />
            </div>
            <button
              type="button"
              disabled={!!busy || !hasPkg}
              onClick={() => void handleRunAsDownload()}
              className="flex items-center gap-1 rounded border border-slate-600 bg-slate-800 px-3 py-2 text-xs text-slate-200 disabled:opacity-40"
            >
              <Download size={14} />
              下载
            </button>
          </div>
          {runAsOut && (
            <pre className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-all rounded border border-slate-800 bg-slate-950 p-2 text-[10px] text-slate-400">
              {runAsOut}
            </pre>
          )}
        </div>

        {/* Monkey + WebView */}
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
          <h4 className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <Zap size={12} /> Monkey
          </h4>
          <div className="mb-2 grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-slate-500">事件数</label>
              <input
                type="number"
                min={1}
                max={50000}
                value={monkeyEvents}
                onChange={(e) => setMonkeyEvents(Number(e.target.value) || 500)}
                className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-500">节流 ms</label>
              <input
                type="number"
                min={0}
                max={5000}
                value={monkeyThrottle}
                onChange={(e) => setMonkeyThrottle(Number(e.target.value) || 0)}
                className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
              />
            </div>
          </div>
          <button
            type="button"
            disabled={!!busy || !hasPkg}
            onClick={() => void handleMonkey()}
            className="w-full rounded border border-amber-800/50 bg-amber-950/20 py-2 text-xs text-amber-100 hover:bg-amber-950/35 disabled:opacity-40"
          >
            {busy === 'monkey' ? <Loader2 size={14} className="mx-auto animate-spin" /> : '运行 Monkey'}
          </button>
          {monkeyOut && (
            <pre className="mt-2 max-h-28 overflow-auto text-[10px] text-slate-500">{monkeyOut}</pre>
          )}
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
          <h4 className="mb-3 flex items-center gap-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">
            <Layers size={12} /> WebView 调试摘要
          </h4>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => void handleWebViewSummary()}
            className="w-full rounded border border-slate-700 bg-slate-900 py-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            {busy === 'wv' ? <Loader2 size={14} className="mx-auto animate-spin" /> : '刷新套接字 / 页面数'}
          </button>
          {wvSummary && <p className="mt-2 text-[10px] leading-relaxed text-slate-400">{wvSummary}</p>}
        </div>
      </div>

      {installLog && (
        <pre className="max-h-40 overflow-auto rounded border border-slate-800 bg-slate-950 p-3 text-[10px] text-slate-400 whitespace-pre-wrap break-all">
          {installLog}
        </pre>
      )}
    </div>
  );
};
