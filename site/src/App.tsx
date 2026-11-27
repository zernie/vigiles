import { Toaster } from "@/components/ui/toaster";
import { Hero } from "@/components/sections/Hero";
import { TestsEvals } from "@/components/sections/TestsEvals";
import { Lint } from "@/components/sections/Lint";
import { DemoAudit } from "@/components/sections/DemoAudit";
import { Start } from "@/components/sections/Start";
import { Footer } from "@/components/Footer";

/**
 * The landing page, top to bottom (light only; tinted bands alternate):
 *
 *   Hero        — the problem in one line, `npx vigiles audit`, and the real
 *                 terminal output it prints on a small broken setup.
 *   TestsEvals  — `#tests`: a deterministic hook test beside a real-model eval,
 *                 each with the output it actually prints.
 *   Lint        — `#lint`: what `vigiles lint` catches in an instruction file
 *                 (a rule switched off, a context that keeps growing).
 *   DemoAudit   — `#try`: grade a public repo in the browser with the same
 *                 engine; the featured repos are baked real reports.
 *   Start       — `#start`: one command, or one sentence for your agent, and the
 *                 three questions people ask before running it.
 *
 * Every command output on the page is captured from the real CLI or read from a
 * committed fixture; none is typed by hand. The design is the light "v9" layout.
 */
export function App() {
  return (
    <>
      <main className="min-h-screen">
        <Hero />
        <TestsEvals />
        <Lint />
        <DemoAudit />
        <Start />
        <Footer />
      </main>
      <Toaster />
    </>
  );
}
