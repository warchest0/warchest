import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { LevelExplainer } from "@/components/landing/LevelExplainer";
import { Faq, FinalCta, Transparency } from "@/components/landing/Sections";

export default function Home() {
  return (
    <>
      <Hero />
      <HowItWorks />
      <LevelExplainer />
      <Transparency />
      <Faq />
      <FinalCta />
    </>
  );
}
