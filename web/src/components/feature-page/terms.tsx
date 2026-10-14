// Terms of use: short and plain, like the rest of the site.

import f from "./feature.module.css";

export function Terms() {
  return (
    <main className={f.page}>
      <article className={f.prose}>
        <p className={f.eyebrow}>
          <span>{"//"}</span> Terms of use <span>{"\\\\"}</span>
        </p>
        <h1>The plain rules.</h1>
        <p className={f.updated}>Last updated 12 October 2026</p>

        <h2>What PANTHEON is</h2>
        <p>
          PANTHEON is a website and a set of public contracts on Elysium. The contracts have no owner: once they are live, no one, including us, can change
          them or move what they hold. This website only helps you read and use them.
        </p>

        <h2>Not advice</h2>
        <p>Nothing on this site is financial, legal or tax advice. Examples on these pages, such as coin names and numbers, are made up to show how things work.</p>

        <h2>The risks</h2>
        <ul>
          <li>PNTH and the coins in the basket can lose some or all of their value.</li>
          <li>Contracts can have bugs, and contracts with no owner can’t be patched.</li>
          <li>Blockchains, wallets and the sites around them can fail or be attacked.</li>
          <li>A trade or a burn on-chain can’t be undone.</li>
        </ul>

        <h2>Your part</h2>
        <p>
          You keep your own keys and you are responsible for what you sign. Only use PANTHEON where it is legal for you to do so, and never put in more than
          you can afford to lose.
        </p>

        <h2>No promises</h2>
        <p>
          The site and the contracts are provided as they are. We don’t promise any return, price or result, and we aren’t liable for losses from using
          them.
        </p>

        <h2>Changes</h2>
        <p>We may update these terms as PANTHEON grows. The date at the top shows the latest version.</p>
      </article>
    </main>
  );
}
