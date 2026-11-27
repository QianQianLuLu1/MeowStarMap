import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { cancelInstall, getInstallLog, getInstallProgress } from '../api'

interface ProgressPayload {
  percent: number
  message: string
  cancellable?: boolean
}

const ProgressStep = (): React.JSX.Element => {
  const [progress, setProgress] = useState<ProgressPayload>({
    percent: 0,
    message: '准备安装',
    cancellable: true
  })
  const [logs, setLogs] = useState<string[]>([])
  const [canceling, setCanceling] = useState(false)

  useEffect(() => {
    let alive = true
    const timer = setInterval(() => {
      void Promise.all([getInstallProgress(), getInstallLog()])
        .then(([next, nextLogs]) => {
          if (!alive) return
          setProgress((prev) => ({
            ...next,
            percent: Math.max(prev.percent, next.percent),
            cancellable: next.cancellable ?? prev.cancellable
          }))
          setLogs(nextLogs)
        })
        .catch(() => {
          // 安装尚未开始/已完成时允许失败，下一轮重试
        })
    }, 250)

    let unlisten: (() => void) | undefined
    const pending = listen<ProgressPayload>('installer-progress', (event) => {
      setProgress((prev) => ({
        ...event.payload,
        percent: Math.max(prev.percent, event.payload.percent),
        cancellable: event.payload.cancellable ?? prev.cancellable
      }))
    })
    void pending
      .then((fn) => {
        if (alive) {
          unlisten = fn
        } else {
          fn()
        }
      })
      .catch(() => {
        // 事件通道不可用时由轮询兜底
      })

    return () => {
      alive = false
      clearInterval(timer)
      unlisten?.()
    }
  }, [])

  const handleCancel = async (): Promise<void> => {
    setCanceling(true)
    try {
      await cancelInstall()
    } catch {
      setCanceling(false)
    }
  }

  return (
    <div className="progress-page">
      <h1>正在安装</h1>
      <p className="lead">{progress.message}</p>

      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${Math.max(progress.percent, 4)}%` }} />
      </div>
      <p className="lead">{progress.percent}%</p>

      <div className="install-log" aria-label="安装日志">
        {logs.length > 0 ? logs.join('\n') : '等待安装日志…'}
      </div>

      <div className="progress-footer">
        <p className="lead">
          {progress.cancellable === false
            ? '文件替换已进入不可逆提交点，安装将继续完成。'
            : '取消后会回滚到安装前状态，已安装的旧版本不受影响。'}
        </p>
        <button
          type="button"
          className="ghost"
          disabled={canceling || progress.cancellable === false}
          onClick={() => void handleCancel()}
        >
          {canceling ? '正在取消…' : '取消安装'}
        </button>
      </div>
    </div>
  )
}

export default ProgressStep
