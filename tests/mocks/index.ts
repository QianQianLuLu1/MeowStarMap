/**
 * 共享测试 mock 工具库入口（tests/mocks/）
 *
 * - createLoggerMock：logger（src/main/utils/logger）同形状 mock
 * - createElectronMock：electron 组合式工厂（app/ipcMain/utilityProcess/BrowserWindow/shell/dialog）
 * - installBetterSqlite3Hook / uninstallBetterSqlite3Hook：Module._load 拦截 require('better-sqlite3')
 * - installParentPortStub / uninstallParentPortStub：process.parentPort 可控桩
 * - mock-validator：src/main/ipc/validator 的共享 mock（IPC handler 测试经 vi.mock 间接引入）
 *
 * 注意：本目录不在 vitest include 范围内（仅 src/**\/*.test.ts），
 * 仅供测试文件按需 import 复用。
 */
export * from './logger'
export * from './electron'
export * from './parent-port'
export * from './sqlite/require-hook'
export * from './mock-validator'
