import { useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** Copy `text` to the clipboard; `copied` flips for 1.6s as feedback. */
export function useCopy(text: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);
  function copy(): void {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        toast("Copied");
        setTimeout(() => setCopied(false), 1600);
      },
      () => toast("Could not copy — select the text instead"),
    );
  }
  return { copied, copy };
}

/** Small "Copy" pill used in terminal chrome and command boxes. */
export function CopyPill({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const { copied, copy } = useCopy(text);
  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={copy}
      aria-label="Copy"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-[#3a3731] px-2 py-0.5 font-sans text-xs text-[#8f897c] transition-colors hover:text-[#e9e4d8]",
        className,
      )}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Dark terminal card: chrome dots, a title and a Copy button over `children`. */
export function Term({
  title = "~/your-repo",
  copyText,
  children,
  className,
}: {
  title?: string;
  copyText: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("term", className)}>
      <div className="-mt-3.5 mb-5 flex items-center gap-[7px] border-b border-[#2c2a25] pb-3.5">
        <i className="h-[11px] w-[11px] rounded-full bg-[#3a3731]" />
        <i className="h-[11px] w-[11px] rounded-full bg-[#3a3731]" />
        <i className="h-[11px] w-[11px] rounded-full bg-[#3a3731]" />
        <span className="ml-2.5 text-xs text-[#8f897c]">{title}</span>
        <CopyPill text={copyText} className="ml-auto" />
      </div>
      {children}
    </div>
  );
}
