export const ARTIST_CARD_HEIGHT = 60
export const ALBUM_CARD_HEIGHT = 74
export const SONG_ROW_HEIGHT = 54

export const GRID_GAP_PX = 12
export const GRID_ROW_OVERSCAN = 3
export const SONG_ROW_OVERSCAN = 10

export function getGridColumnCount(width: number): number {
  if (width >= 1280) return 6
  if (width >= 1024) return 5
  if (width >= 768) return 4
  if (width >= 640) return 3
  return 2
}

export function chunkItems<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return []

  const rows: T[][] = []
  for (let index = 0; index < items.length; index += chunkSize) {
    rows.push(items.slice(index, index + chunkSize))
  }
  return rows
}

export function getVirtualGridRowHeight(
  containerWidth: number,
  columnCount: number,
  cardDetailHeight: number
): number {
  if (columnCount <= 0) return cardDetailHeight

  const totalGap = Math.max(columnCount - 1, 0) * GRID_GAP_PX
  const cardWidth = Math.max((containerWidth - totalGap) / columnCount, 0)
  return cardWidth + cardDetailHeight + GRID_GAP_PX
}
