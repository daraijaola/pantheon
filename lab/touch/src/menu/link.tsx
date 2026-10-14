// In the lab a link is a plain <a>; the site swaps this for next/link when the menu is ported.
export { A };
function A(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return <a {...props} />;
}
