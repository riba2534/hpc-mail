import { afterEach } from 'vitest';

/**
 * 收集被测代码登记到 waitUntil 的后台任务（结果回填重试、通知、转发等），每个用例结束前全部等完。
 * 直接丢弃的任务会在用例结束后继续跑；拆测试环境时它还在写日志，vitest 记为 Unhandled Rejection
 * （EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending），进程退出 1。
 * 在测试文件顶层调用一次：注册 afterEach，并返回可传给 sendMail 等函数的 ctx。
 */
export function collectBackground() {
  const tasks: Promise<unknown>[] = [];
  const background = {
    ctx: { waitUntil: (promise: Promise<unknown>) => { tasks.push(promise); } },
    /** 等完已登记的任务（含等待期间新登记的） */
    async settle(): Promise<void> {
      while (tasks.length) await Promise.allSettled(tasks.splice(0));
    },
  };
  afterEach(() => background.settle());
  return background;
}
