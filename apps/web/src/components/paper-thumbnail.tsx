import { cn } from "@/lib/utils";
import type { TemplateId } from "@latex-free/shared";
export function PaperThumbnail({
  template,
  className,
}: {
  template: TemplateId;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("paper-scene", `paper-scene-${template}`, className)}
    >
      <div className={cn("mini-paper", template === "resume" && "mini-resume")}>
        {template === "blank" ? (
          <>
            <div className="mini-title">Your next idea.</div>
            <div className="mini-subtitle">A blank page is a beginning.</div>
            <div className="mini-section">1 &nbsp; Introduction</div>
          </>
        ) : template === "resume" ? (
          <>
            <div className="mini-title">Alex Morgan</div>
            <div className="mini-subtitle">DESIGNER · RESEARCHER · THINKER</div>
            <div className="mini-rule" />
            <div className="mini-section">EXPERIENCE</div>
          </>
        ) : template === "report" ? (
          <>
            <div className="mini-overline">RESEARCH & EXPLORATION</div>
            <div className="mini-title">
              The bigger
              <br />
              picture.
            </div>
            <div className="mini-rule" />
            <div className="mini-subtitle">A research report</div>
          </>
        ) : (
          <>
            <div className="mini-title">A new perspective</div>
            <div className="mini-subtitle">Notes on what comes next</div>
            <div className="mini-section">Abstract</div>
          </>
        )}
        <div className="mini-lines">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
        {template !== "report" && (
          <>
            <div className="mini-section">
              {template === "resume" ? "EDUCATION" : "1.1   A starting point"}
            </div>
            <div className="mini-lines">
              <i />
              <i />
              <i />
            </div>
          </>
        )}
        <span className="mini-page-number">1</span>
      </div>
    </div>
  );
}
