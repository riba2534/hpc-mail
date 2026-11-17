import { Inbox, RotateCw } from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { RouteErrorView } from './route-error-page';

/**
 * 外壳内页面的错误边界：页面渲染异常或 chunk 加载失败只替换主内容区，侧边栏与导航保留。
 * 「重试」重新导航到当前地址：路由错误边界随之重置，页面重新挂载并重新加载失败的 chunk。
 */
export function PageError() {
  const navigate = useNavigate();
  const { pathname, search, hash, state } = useLocation();
  return (
    <RouteErrorView
      className="grid min-h-96 place-items-center px-6 py-10"
      actions={
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => navigate({ pathname, search, hash }, { replace: true, state })}>
            <RotateCw className="size-4" />
            重试
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
