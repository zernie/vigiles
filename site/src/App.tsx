import { StickyCTA } from "@/components/StickyCTA";
import { Toaster } from "@/components/ui/toaster";
import { Hero } from "@/components/sections/Hero";
import { Wedge } from "@/components/sections/Wedge";
import { Measure } from "@/components/sections/Measure";
import { Guard } from "@/components/sections/Guard";
import { VerbMap } from "@/components/sections/VerbMap";
import { Adoption } from "@/components/sections/Adoption";
import { FAQ } from "@/components/sections/FAQ";
import { Docs } from "@/components/sections/Docs";
import { CTA } from "@/components/sections/CTA";
import { Footer } from "@/components/Footer";

export function App() {
  return (
    <>
      <StickyCTA />
      <main className="min-h-screen">
        <Hero />
        <Wedge />
        <Measure />
        <Guard />
        <VerbMap />
        <Adoption />
        <FAQ />
        <Docs />
        <CTA />
        <Footer />
      </main>
      <Toaster />
    </>
  );
}
