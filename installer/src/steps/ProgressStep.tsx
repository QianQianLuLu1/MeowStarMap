import { useEffect, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { getInstallProgress } from '../api'

interface ProgressPayload {
  percent: number
  message: string
}

const ProgressStep = (): React.JSX.Element => {
  const [progress, setProgress] = useState<ProgressPayload>({
    percent: 0,
    message: '准备安装'
  })

  useEffect(() => {
    let alive = true
    const timer = setInterval(() => {
      void getInstallProgress()
        .then((next) => {
          if (alive) setProgress(next)
        })
        .catch(() => {
          // 安装尚未开始/已完成时允许失败，下一轮重试
        })
    }, 250)

    let unlisten: (() => void) | undefined
    const pending = listen<ProgressPayload>('installer-progress', (event) => {
      setProgress(event.payload)
    })
    void pending
      .then((fn) => {
        unlisten = fn
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

  return (
    <div>
      <h1>正在安装</h1>
      <p className="lead">{progress.message}</p>

      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${Math.max(progress.percent, 4)}%` }} />
      </div>
      <p className="lead">{progress.percent}%</p>
    </div>
  )
}

export default ProgressStep
