import { ButtonLink } from "@/components/ui/primitives";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-4 py-32 text-center">
      <div className="num text-6xl font-semibold text-gradient">404</div>
      <p className="mt-4 text-muted">This page does not exist.</p>
      <ButtonLink href="/index.html" className="mt-8">
        Back home
      </ButtonLink>
    </div>
  );
}
