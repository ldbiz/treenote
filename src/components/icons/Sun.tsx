import type { SVGProps } from "react";
const SvgSun = (props: SVGProps<SVGSVGElement>) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={24}
    height={24}
    fill="currentColor"
    viewBox="0 -960 960 960"
    {...props}
  >
    <path d="M480-360q50 0 85-35t35-85-35-85-85-35-85 35-35 85 35 85 85 35m0 80q-83 0-141.5-58.5T280-480t58.5-141.5T480-680t141.5 58.5T680-480t-58.5 141.5T480-280M200-440H40v-80h160zm720 0H760v-80h160zM440-760v-160h80v160zm0 720v-160h80v160zm256-328-56-56 112-112 56 56zm-480 0-112-112 56-56 112 112zm480 224-112-112 56-56 112 112zm-480 0-56-56 112-112 56 56z" />
  </svg>
);
export default SvgSun;
