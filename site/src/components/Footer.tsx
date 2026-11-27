const REPO = "https://github.com/zernie/vigiles";

const LINK = "ml-4 text-muted-foreground no-underline hover:text-foreground";

export function Footer() {
  return (
    <footer className="mx-auto flex w-full max-w-[1180px] flex-wrap justify-between gap-2.5 border-t border-border px-6 pb-10 pt-7 text-[13px] text-muted-foreground">
      <span>vigiles · MIT</span>
      <span>
        <a
          href={`${REPO}/blob/main/docs/README.md`}
          target="_blank"
          rel="noopener noreferrer"
          className={LINK}
        >
          Docs
        </a>
        <a
          href={REPO}
          target="_blank"
          rel="noopener noreferrer"
          className={LINK}
        >
          GitHub
        </a>
        <a
          href="https://www.npmjs.com/package/vigiles"
          target="_blank"
          rel="noopener noreferrer"
          className={LINK}
        >
          npm
        </a>
        <a href="./comparison/" className={LINK}>
          Compare
        </a>
      </span>
    </footer>
  );
}
