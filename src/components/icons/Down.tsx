import type { SVGProps } from "react";
const SvgDown = (props: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={24}
    height={24}
    fill="currentColor"
    viewBox="0 -960 960 960"
    {...props}
  >
    <path d="M440-800v487L216-537l-56 57 320 320 320-320-56-57-224 224v-487z" />
  </svg>
);
export default SvgDown;
