import { Inbox, RotateCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { RouteErrorView } from './route-error-page';

/**
 * 外壳内页面的错误边界：页面渲染异常或 chunk 加载失败只替换主内容区，侧边栏与导航保留。
 * 重试用整页刷新：chunk 加载失败（多为发版后旧文件已删除）在同一文档里重新 import 拿不到新版本，
 * 刷新才能换到新版本；也可以直接回收件箱或用侧边栏去其他页面。
 */
export function PageError() {
  return (
    <RouteErrorView
      className="grid min-h-96 place-items-center px-6 py-10"
      actions={
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => globalThis.location.reload()}>
            <RotateCw className="size-4" />
            刷新页面
          </Button>
          <Button variant="secondary" asChild>
            <Link to="/inbox">
              <Inbox className="size-4" />
              返回收件箱
            </Link>
          </Button>
        </div>
      }
    />
  );
}
