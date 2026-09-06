import type { SVGProps } from "react";
const SvgMoon = (props: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={24}
    height={24}
    fill="currentColor"
    viewBox="0 -960 960 960"
    {...props}
  >
    <path d="M480-120q-150 0-255-105T120-480q0-150 105-255t255-105q14 0 28.5 1t29.5 3q-41 29-65.5 75.5T444-660q0 90 63 153t153 63q55 0 101-24.5t75-65.5q2 15 3 29.5t1 28.5q0 150-105 255T480-120" />
  </svg>
);
export default SvgMoon;
