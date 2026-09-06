import type { SVGProps } from "react";
const SvgAutoTheme = (props: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={24}
    height={24}
    fill="currentColor"
    viewBox="0 -960 960 960"
    {...props}
  >
    <path d="M480-80q-83 0-156-31.5T197-197-31.5-636 80-792v-48h80v48q0 133 93.5 226.5T480-480q133 0 226.5-93.5T800-800v-48h80v48q0 83-31.5 156T763-197-636-31.5-480 80m0-400q-50 0-85-35t-35-85 35-85 85-35 85 35 35 85-35 85-85 35" />
  </svg>
);
export default SvgAutoTheme;
