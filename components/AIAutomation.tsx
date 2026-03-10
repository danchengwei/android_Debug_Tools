import React, { useState, useEffect, useRef } from 'react';
import { Play, Square, Loader2, Sparkles, History, CheckCircle2, AlertCircle, Send } from 'lucide-react';
import { adbService } from '../services/adbService';
import { getNextAutomationAction } from '../services/geminiService';
import { AutomationStep, AIAction } from '../types';

interface AIAutomationProps {
  connected: boolean;
}

export const AIAutomation: React.FC<AIAutomationProps> = ({ connected }) => {
  const [goal, setGoal] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [steps, setSteps] = useState<AutomationStep[]>([]);
  const [error, setError] = useState<string | null>(null);
  
  const isRunningRef = useRef(false);

  const startAutomation = async () => {
    if (!goal || !connected || isRunning) return;
    
    setIsRunning(true);
    isRunningRef.current = true;
    setError(null);
    setSteps([]);

    const history: string[] = [];

    /** 将 blob URL 转为 base64 data URL，供 Gemini 接口使用 */
    const blobUrlToBase64 = async (url: string): Promise<string> => {
      const res = await fetch(url);
      const blob = await res.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    };

    try {
      while (isRunningRef.current) {
        // 1. 截屏（返回 blob URL），转为 base64 供 Gemini 与步骤展示使用
        const screenshotBlobUrl = await adbService.captureScreen();
        const screenshotBase64 = await blobUrlToBase64(screenshotBlobUrl);
        if (screenshotBlobUrl) URL.revokeObjectURL(screenshotBlobUrl);

        // 2. 使用 base64 图片调用 AI 决策
        const action = await getNextAutomationAction(screenshotBase64, goal, history);
        
        const step: AutomationStep = {
          id: Math.random().toString(36).substr(2, 9),
          action,
          status: 'running',
          screenshot: screenshotBase64,
          timestamp: Date.now()
        };
        
        setSteps(prev => [...prev, step]);
        history.push(`${action.type}${action.params?.reason ? ` (${action.params.reason})` : ''}`);

        if (action.type === 'finish') {
          setSteps(prev => prev.map(s => s.id === step.id ? { ...s, status: 'completed' } : s));
          break;
        }

        // 3. Execute action
        try {
          switch (action.type) {
            case 'click':
              if (action.params?.x !== undefined && action.params?.y !== undefined) {
                await adbService.tap(action.params.x, action.params.y);
              }
              break;
            case 'input':
              if (action.params?.text) {
                await adbService.inputText(action.params.text);
              }
              break;
            case 'scroll':
              if (action.params?.direction) {
                await adbService.scroll(action.params.direction as any);
              }
              break;
            case 'back':
              await adbService.sendKeyEvent(4);
              break;
            case 'home':
              await adbService.sendKeyEvent(3);
              break;
          }
          setSteps(prev => prev.map(s => s.id === step.id ? { ...s, status: 'completed' } : s));
        } catch (e: any) {
          setSteps(prev => prev.map(s => s.id === step.id ? { ...s, status: 'failed' } : s));
          throw e;
        }

        // Wait for UI to update
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsRunning(false);
      isRunningRef.current = false;
    }
  };

  const stopAutomation = () => {
    isRunningRef.current = false;
    setIsRunning(false);
  };

  return (
    <div className="flex flex-col h-full bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-lg">
      <div className="flex items-center justify-between px-4 py-3 bg-slate-850 border-b border-slate-800">
        <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
          <Sparkles size={16} className="text-purple-400" />
          AI 自动化测试
        </h3>
        {isRunning && (
          <div className="flex items-center gap-2 text-[10px] text-purple-400 animate-pulse">
            <Loader2 size={12} className="animate-spin" />
            正在执行任务...
          </div>
        )}
      </div>

      <div className="p-4 flex flex-col gap-4 flex-1 overflow-hidden">
        <div className="flex flex-col gap-2">
          <label className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">测试目标</label>
          <div className="flex gap-2">
            <input 
              type="text" 
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              placeholder="例如: 打开设置，找到电池选项并截图"
              disabled={isRunning || !connected}
              className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-purple-500 transition-colors disabled:opacity-50"
            />
            {!isRunning ? (
              <button 
                onClick={startAutomation}
                disabled={!goal || !connected}
                className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-lg shadow-purple-900/20 disabled:opacity-50 flex items-center gap-2"
              >
                <Play size={16} /> 开始
              </button>
            ) : (
              <button 
                onClick={stopAutomation}
                className="bg-red-600 hover:bg-red-500 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors shadow-lg shadow-red-900/20 flex items-center gap-2"
              >
                <Square size={16} /> 停止
              </button>
            )}
          </div>
        </div>

        {error && (
          <div className="bg-red-950/30 border border-red-900/50 p-3 rounded-lg flex items-start gap-3">
            <AlertCircle size={16} className="text-red-400 shrink-0 mt-0.5" />
            <div className="text-xs text-red-300">{error}</div>
          </div>
        )}

        <div className="flex-1 flex flex-col gap-2 overflow-hidden">
          <div className="flex items-center justify-between">
            <label className="text-[10px] uppercase tracking-wider text-slate-500 font-bold">执行步骤</label>
            <span className="text-[10px] text-slate-600">{steps.length} 步</span>
          </div>
          
          <div className="flex-1 overflow-y-auto space-y-3 pr-2 custom-scrollbar">
            {steps.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-600 gap-2 opacity-50">
                <History size={32} />
                <p className="text-xs">暂无执行记录</p>
              </div>
            ) : (
              steps.map((step, index) => (
                <div key={step.id} className="bg-slate-950/50 border border-slate-800 rounded-lg overflow-hidden">
                  <div className="flex items-center justify-between px-3 py-2 bg-slate-900/50 border-b border-slate-800">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-slate-500">#{index + 1}</span>
                      <span className="text-xs font-bold text-slate-300 uppercase">{step.action.type}</span>
                    </div>
                    {step.status === 'running' ? (
                      <Loader2 size={12} className="animate-spin text-purple-400" />
                    ) : step.status === 'completed' ? (
                      <CheckCircle2 size={12} className="text-green-500" />
                    ) : (
                      <AlertCircle size={12} className="text-red-500" />
                    )}
                  </div>
                  <div className="p-3 flex gap-3">
                    {step.screenshot && (
                      <img src={step.screenshot} className="w-16 h-28 object-cover rounded border border-slate-800" alt="Step Screenshot" />
                    )}
                    <div className="flex-1 flex flex-col gap-1">
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        {step.action.params?.reason || '执行自动化操作'}
                      </p>
                      {step.action.params?.text && (
                        <div className="text-[10px] bg-slate-900 px-2 py-1 rounded text-cyan-400 font-mono mt-1">
                          输入: {step.action.params.text}
                        </div>
                      )}
                      {(step.action.params?.x !== undefined) && (
                        <div className="text-[10px] text-slate-500 font-mono">
                          坐标: ({step.action.params.x}, {step.action.params.y})
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )).reverse()
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
