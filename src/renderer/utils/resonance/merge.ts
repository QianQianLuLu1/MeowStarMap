/**
 * 记录合并/去重纯函数（逻辑复用自 gongeo.us-nikki-tracker 的
 * shared/utils/trackerDataMerge.ts，MIT, dastrokes）。
 *
 * pulls 数组保持最新在前（newest-first）顺序；edits 以 itemId 为幂等键；
 * pearpal / evo 逐键去重合并。与源实现的差异：本仓库 DB 层幂等键更细
 * （pulls 含 itemId），此处保留源语义的纯函数供导入解析与测试复用。
 */
import type { EvoRecord, EditRecord, PearpalTrackerItem, PullRecord } from './types'

export const mergePullData = (
  existingData: Record<number, PullRecord[]>,
  newData: Record<number, PullRecord[]>
): Record<number, PullRecord[]> => {
  const mergedData: Record<number, PullRecord[]> = { ...existingData }

  Object.entries(newData).forEach(([bannerIdStr, newPulls]) => {
    const bannerId = Number(bannerIdStr)
    const existingPulls = mergedData[bannerId] ?? []

    if (existingPulls.length === 0) {
      mergedData[bannerId] = [...newPulls]
      return
    }

    const existingNewest = existingPulls[0]![0]
    const existingOldest = existingPulls.at(-1)![0]
    const existingTimestamps = new Set(existingPulls.map(([ts]) => ts))
    const toPrepend: PullRecord[] = []
    const toAppend: PullRecord[] = []

    for (const [timestamp, itemId] of newPulls) {
      if (existingTimestamps.has(timestamp)) continue

      if (timestamp > existingNewest) {
        toPrepend.push([timestamp, itemId])
      } else if (timestamp < existingOldest) {
        toAppend.push([timestamp, itemId])
      }
    }

    mergedData[bannerId] = [...toPrepend, ...existingPulls, ...toAppend]
  })

  return mergedData
}

export const mergeEditData = (
  existingEdits: Record<number, EditRecord[]>,
  newEdits: Record<number, EditRecord[]>
): Record<number, EditRecord[]> => {
  const mergedEdits: Record<number, EditRecord[]> = { ...existingEdits }

  Object.entries(newEdits).forEach(([bannerIdStr, newEditRecords]) => {
    const bannerId = Number(bannerIdStr)
    const existingRecords = mergedEdits[bannerId] || []
    const existingEditMap = new Map<string, EditRecord>()

    existingRecords.forEach((edit) => {
      existingEditMap.set(edit[1], edit)
    })

    newEditRecords.forEach((newEdit) => {
      const existingEdit = existingEditMap.get(newEdit[1])
      if (!existingEdit) {
        existingRecords.push(newEdit)
      }
    })

    mergedEdits[bannerId] = existingRecords
  })

  return mergedEdits
}

export const mergeEvoData = (
  localRecords: Record<number, EvoRecord[]> | undefined,
  remoteRecords: Record<number, EvoRecord[]> | undefined,
  mode: 'upload' | 'download'
): Record<number, EvoRecord[]> => {
  if (mode === 'upload') {
    return { ...(remoteRecords ?? {}), ...(localRecords ?? {}) }
  }

  return { ...(localRecords ?? {}), ...(remoteRecords ?? {}) }
}

export const mergeArrayRecords = <T>(
  localRecords: Record<number, T[]> | undefined,
  remoteRecords: Record<number, T[]> | undefined,
  getKey: (row: T) => string
) => {
  const merged: Record<number, T[]> = Object.fromEntries(
    Object.entries(localRecords ?? {}).map(([key, rows]) => [key, [...rows]])
  )

  Object.entries(remoteRecords ?? {}).forEach(([key, remoteRows]) => {
    const existingRows = merged[Number(key)] ?? []
    const seen = new Set(existingRows.map(getKey))
    const additions = remoteRows.filter((row) => {
      const rowKey = getKey(row)
      if (seen.has(rowKey)) return false
      seen.add(rowKey)
      return true
    })

    merged[Number(key)] = [...existingRows, ...additions]
  })

  return merged
}

export const mergePearpalData = (
  localRecords: Record<number, PearpalTrackerItem[]> | undefined,
  remoteRecords: Record<number, PearpalTrackerItem[]> | undefined
): Record<number, PearpalTrackerItem[]> =>
  mergeArrayRecords(localRecords, remoteRecords, (row) => JSON.stringify(row))
