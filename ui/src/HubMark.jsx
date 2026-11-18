import React, { useEffect, useRef } from 'react';
import brand from './brand.json';

export default function HubMark() {
  const mark = useRef(null);
  useEffect(() => {
    const source = new XMLSerializer().serializeToString(mark.current);
    document.querySelector('link[rel="icon"]')?.setAttribute('href', 'data:image/svg+xml,' + encodeURIComponent(source));
  }, []);
  return <svg ref={mark} xmlns="http://www.w3.org/2000/svg" viewBox={'0 0 ' + brand.size + ' ' + brand.size} aria-hidden="true">
    <rect width={brand.size} height={brand.size} rx={brand.radius} fill={brand.background}/>
    <g fill={brand.foreground}>
      {brand.shapes.map((points, index) => <polygon key={index} points={points.map(point => point.join(',')).join(' ')}/>)}
    </g>
  </svg>;
}
