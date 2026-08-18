import React, { useEffect, useRef, useState } from 'react'

interface VideoPlayerProps {
  src: string
  className?: string
  autoPlay?: boolean
  controls?: boolean
  onTimeUpdate?: (currentTime: number) => void
  onCaptureFrame?: (currentTime: number) => void
}

function hashString(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash |= 0
  }
  return `vp-${Math.abs(hash).toString(36)}`
}

function getVideoStorageKey(src: string): string {
  return `video-progress-${hashString(src)}`
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  src,
  className = '',
  autoPlay = false,
  controls = true,
  onTimeUpdate,
  onCaptureFrame
}) => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [restoredTime, setRestoredTime] = useState<number | null>(null)
  const hasRestoredRef = useRef(false)

  const handleTimeUpdate = () => {
    const time = videoRef.current?.currentTime || 0
    setCurrentTime(time)
    onTimeUpdate?.(time)
  }

  const saveProgress = () => {
    if (!videoRef.current || !src) return
    try {
      // U-G8：保存进度时附带时间戳，用于过期清理
      localStorage.setItem(
        getVideoStorageKey(src),
        JSON.stringify({ currentTime: videoRef.current.currentTime, savedAt: Date.now() })
      )
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    hasRestoredRef.current = false
    setRestoredTime(null)
  }, [src])

  // U-G8：挂载时清理超过 30 天的视频进度记录
  useEffect(() => {
    const now = Date.now()
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith('video-progress-')) continue
      try {
        const data = JSON.parse(localStorage.getItem(key) || '{}')
        if (data.savedAt && now - data.savedAt > THIRTY_DAYS) {
          localStorage.removeItem(key)
        }
      } catch {
        localStorage.removeItem(key) // 解析失败也清除
      }
    }
  }, [])

  const handleLoadedMetadata = () => {
    handleTimeUpdate()
    if (!hasRestoredRef.current && videoRef.current && src) {
      hasRestoredRef.current = true
      try {
        const saved = localStorage.getItem(getVideoStorageKey(src))
        if (saved) {
          // U-G8：兼容新格式（{ currentTime, savedAt }）和旧格式（纯数字字符串）
          let time: number
          try {
            const parsed = JSON.parse(saved)
            time =
              typeof parsed === 'object' && parsed !== null ? parsed.currentTime : parseFloat(saved)
          } catch {
            time = parseFloat(saved)
          }
          if (time > 0 && time < (videoRef.current.duration || Infinity)) {
            videoRef.current.currentTime = time
            setRestoredTime(time)
            setTimeout(() => setRestoredTime(null), 3000)
          }
        }
      } catch {
        // ignore
      }
    }
  }

  const handlePause = () => {
    saveProgress()
  }

  const handleEnded = () => {
    if (src) {
      try {
        localStorage.removeItem(getVideoStorageKey(src))
      } catch {
        // ignore
      }
    }
  }

  const toggleFullscreen = async () => {
    const container = containerRef.current
    if (!container) return
    try {
      if (!document.fullscreenElement) {
        await container.requestFullscreen()
        setIsFullscreen(true)
      } else {
        await document.exitFullscreen()
        setIsFullscreen(false)
      }
    } catch {
      // ignore
    }
  }

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  const handleCapture = () => {
    onCaptureFrame?.(currentTime)
  }

  return (
    <div ref={containerRef} className={`relative group ${className}`}>
      <video
        ref={videoRef}
        src={src}
        controls={controls}
        autoPlay={autoPlay}
        className="w-full h-full"
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleLoadedMetadata}
        onPause={handlePause}
        onEnded={handleEnded}
      />
      {restoredTime !== null && (
        <div
          className="absolute top-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg text-xs font-medium z-10"
          style={{ background: 'var(--overlay-bg-strong)', color: 'var(--text-on-overlay)' }}
        >
          已恢复至 {formatTime(restoredTime)}
        </div>
      )}
      <div className="absolute top-4 right-4 flex gap-2 opacity-60 group-hover:opacity-100 transition-opacity">
        <button
          onClick={toggleFullscreen}
          className="px-3 py-1.5 rounded-lg text-xs font-medium"
          style={{
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            border: '1px solid var(--divider)'
          }}
          title={isFullscreen ? '退出全屏' : '全屏播放'}
          aria-label={isFullscreen ? '退出全屏' : '全屏播放'}
        >
          {isFullscreen ? '退出全屏' : '全屏'}
        </button>
        {onCaptureFrame && (
          <button
            onClick={handleCapture}
            className="px-3 py-1.5 rounded-lg text-xs font-medium"
            style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
            title="截取当前帧"
            aria-label="截取当前帧"
          >
            截图
          </button>
        )}
      </div>
    </div>
  )
}
