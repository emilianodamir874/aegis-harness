import { useColorMode } from '@docusaurus/theme-common';

export const AegisLogo = (props: { className?: string }) => {
  const { colorMode } = useColorMode();
  
  const logoSrc = colorMode === 'dark' 
    ? 'img/aegis-logo-white.png' 
    : 'img/aegis-logo-black.png';
  
  const logoAlt = 'aegis logo';

  return (
    <img
      src={logoSrc}
      alt={logoAlt}
      className={props.className}
      style={{ height: 'auto', maxWidth: '100%' }}
    />
  );
};
