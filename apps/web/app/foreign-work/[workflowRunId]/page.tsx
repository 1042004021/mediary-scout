import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { ArrowLeft, Film, TriangleAlert } from "lucide-react";
import { AppSidebar } from "../../../components/app-sidebar";
import { GitHubNameplate } from "../../../components/github-nameplate";
import { ForeignWorkImportForm } from "../../../components/foreign-work-import-form";
import { getForeignWorkReview } from "../../../lib/workflow-runtime";

export default function ForeignWorkPage({
  params,
}: {
  params: Promise<{ workflowRunId: string }>;
}) {
  return (
    <div className="app-shell">
      <AppSidebar active="notifications" />
      <main className="main product-main">
        <Link
          className="nav-item"
          href="/notifications"
          style={{ display: "inline-flex", marginBottom: 16 }}
        >
          <ArrowLeft size={16} aria-hidden />
          返回通知
        </Link>
        <Suspense fallback={<div className="skeleton skeleton-heading" />}>
          <ForeignWorkReview params={params} />
        </Suspense>
        <GitHubNameplate />
      </main>
    </div>
  );
}

async function ForeignWorkReview({ params }: { params: Promise<{ workflowRunId: string }> }) {
  await connection();
  const { workflowRunId } = await params;
  const review = await getForeignWorkReview(decodeURIComponent(workflowRunId));

  if (!review || review.findings.length === 0) {
    return (
      <div className="quiet-state">
        <TriangleAlert size={24} aria-hidden />
        <strong>没有待处理的异作品文件</strong>
        <span>这次运行没有记录需要人工确认的文件。</span>
      </div>
    );
  }

  return (
    <section className="library-surface">
      <div className="section-heading library-heading">
        <div>
          <h1>疑似其他作品</h1>
          <p>{review.titleName} 的资源包携带了以下文件；确认名称后可单独入库为电影。</p>
        </div>
      </div>
      {review.findings.map((finding, index) => (
        <article className="panel" key={`${finding.stagingDirectoryId}_${index}`}>
          <div className="panel-header">
            <div>
              <h2 className="panel-title">
                <Film size={16} aria-hidden style={{ verticalAlign: "-2px", marginRight: 8 }} />
                隔离区 {finding.stagingDirectoryId}
              </h2>
              <p className="panel-note">{finding.files.length} 个文件，确认前不会被移动或删除</p>
            </div>
          </div>
          <ul className="foreign-file-list">
            {finding.files.map((file) => (
              <li key={file.providerFileId}>
                <code>{file.sourcePath}</code>
              </li>
            ))}
          </ul>
          <ForeignWorkImportForm
            providerFileIds={finding.files.map((file) => file.providerFileId)}
          />
        </article>
      ))}
    </section>
  );
}
