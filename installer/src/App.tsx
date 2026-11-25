import { useEffect, useRef, useState } from 'react'
import { detectState, startInstall } from './api'
import type { InstallOptions, InstallSummary, InstallerState } from './types'
import WelcomeStep from './steps/WelcomeStep'
import OptionsStep from './steps/OptionsStep'
import ProgressStep from './steps/ProgressStep'
import FinishStep from './steps/FinishStep'

export const STEP_TITLES = ['欢迎', '安装选项', '正在安装', '完成'] as const

const DEFAULT_OPTIONS: InstallOptions = {
  installDir: '',
  createDesktopShortcut: true,
  importCertificate: true
}

const App = (): React.JSX.Element => {
  const [step, setStep] = useState(0)
  const [state, setState] = useState<InstallerState | null>(null)
  const [options, setOptions] = useState<InstallOptions>(DEFAULT_OPTIONS)
  const [summary, setSummary] = useState<InstallSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const silentStarted = useRef(false)

  const runInstall = async (opts: InstallOptions): Promise<void> => {
    setOptions(opts)
    setStep(2)
    setError(null)
    try {
      const result = await startInstall(opts)
      setSummary(result)
      setStep(3)
    } catch (err: unknown) {
      setError(String(err))
    }
  }

  useEffect(() => {
    detectState()
      .then((s) => {
        setState(s)
        setOptions((prev) => ({ ...prev, installDir: s.installDir ?? '' }))
      })
      .catch((err: unknown) => setError(String(err)))
  }, [])

  useEffect(() => {
    if (state === null || !state.silent || silentStarted.current) {
      return
    }
    silentStarted.current = true
    void runInstall({
      installDir: state.installDir ?? '',
      createDesktopShortcut: true,
      importCertificate: true
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  const modeLabel =
    state?.mode === 'upgrade' ? '覆盖安装' : state?.mode === 'repair' ? '修复安装' : '全新安装'

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">喵</div>
          <div>
            <div className="brand-title">喵星图</div>
            <div className="brand-sub">MeowStarMap</div>
          </div>
        </div>
        <div className="mode-pill">{modeLabel}</div>
        <ol className="steps">
          {STEP_TITLES.map((title, index) => (
            <li key={title} className={index === step ? 'active' : index < step ? 'done' : ''}>
              <span className="dot">{index < step ? '✓' : index + 1}</span>
              <span>{title}</span>
            </li>
          ))}
        </ol>
        <div className="sidebar-foot">
          {state?.installed ? `当前版本 ${state.version ?? '未知'}` : '尚未安装'}
        </div>
      </aside>

      <main className="panel">
        {step === 0 && (
          <WelcomeStep state={state} error={error} onNext={() => setStep(1)} />
        )}
        {step === 1 && (
          <OptionsStep
            state={state}
            options={options}
            onBack={() => setStep(0)}
            onInstall={(opts) => void runInstall(opts)}
          />
        )}
        {step === 2 && <ProgressStep />}
        {step === 2 && error !== null && (
          <>
            <div className="error">安装失败：{error}（已回滚到安装前状态）</div>
            <div className="actions">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setError(null)
                  setStep(1)
                }}
              >
                返回安装选项
              </button>
            </div>
          </>
        )}
        {step === 3 && summary !== null && (
          <FinishStep summary={summary} silent={state?.silent ?? false} onClose={() => window.close()} />
        )}
      </main>
    </div>
  )
}

export default App
