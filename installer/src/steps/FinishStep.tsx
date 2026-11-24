import { useEffect, useState } from 'react'
import { launchApp } from '../api'
import type { InstallSummary } from '../types'

interface FinishStepProps {
  summary: InstallSummary
  silent: boolean
  onClose: () => void
}

const FinishStep = ({ summary, silent, onClose }: FinishStepProps): React.JSX.Element => {
  const [launchError, setLaunchError] = useState<string | null>(null)

  useEffect(() => {
    if (!silent) {
      return
    }
    const timer = setTimeout(() => {
      onClose()
    }, 1500)
    return () => clearTimeout(timer)
  }, [silent, onClose])

  const handleLaunch = async (): Promise<void> => {
    try {
      await launchApp()
    } catch (err: unknown) {
      setLaunchError(String(err))
    }
  }

  return (
    <div>
      <h1>安装完成</h1>
      <p className="lead">
        {summary.mode === 'upgrade' ? '覆盖安装已完成。' : '喵星图已安装到你的电脑。'}
      </p>

      <dl className="summary-grid">
        <dt>安装目录</dt>
        <dd>{summary.installDir}</dd>
        <dt>版本</dt>
        <dd>{summary.version}</dd>
      </dl>

      {summary.steps.length > 0 && (
        <>
          <h2>执行记录</h2>
          <ol className="log-list">
            {summary.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </>
      )}

      {summary.warnings.length > 0 && (
        <>
          <h2>警告</h2>
          <ol className="log-list">
            {summary.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ol>
        </>
      )}

      {launchError !== null && <div className="error">启动应用失败：{launchError}</div>}

      <div className="actions">
        <button type="button" className="primary" onClick={() => void handleLaunch()}>
          启动喵星图
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  )
}

export default FinishStep
