'use client';

export default function BookmarkletPage() {
  const code =
    "javascript:(function(){window.open('" +
    "https://REPLACE_WITH_DEPLOYED_DOMAIN/add?url='" +
    "+encodeURIComponent(location.href),'_blank');})();";

  return (
    <main className="max-w-lg mx-auto p-4">
      <h1 className="text-xl font-bold mb-3">Desktop Bookmarklet</h1>
      <p className="text-sm mb-3">
        Drag this button to your bookmarks bar. On any reel or article page,
        click it to send the page to Reel Vault.
      </p>
      <a
        href={code}
        onClick={(e) => e.preventDefault()}
        className="inline-block bg-black text-white rounded px-3 py-2"
      >
        + Reel Vault
      </a>
      <p className="text-xs text-gray-500 mt-3">
        After deploying, replace REPLACE_WITH_DEPLOYED_DOMAIN in
        src/app/bookmarklet/page.tsx with the real domain.
      </p>
    </main>
  );
}
