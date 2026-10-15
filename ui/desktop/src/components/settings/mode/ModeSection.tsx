import { useEffect, useState } from 'react';
import { all_aegis_modes, ModeSelectionItem } from './ModeSelectionItem';
import { useConfig } from '../../ConfigContext';

export const ModeSection = () => {
  const [currentMode, setCurrentMode] = useState('auto');
  const { config, upsert } = useConfig();

  const handleModeChange = async (newMode: string) => {
    try {
      await upsert('AEGIS_MODE', newMode, false);
      setCurrentMode(newMode);
    } catch (error) {
      console.error('Error updating aegis mode:', error);
      throw new Error(`Failed to store new aegis mode: ${newMode}`, { cause: error });
    }
  };

  useEffect(() => {
    const mode = config.AEGIS_MODE as string | undefined;
    if (mode) {
      setCurrentMode(mode);
    }
  }, [config.AEGIS_MODE]);

  return (
    <div className="space-y-1">
      {all_aegis_modes.map((mode) => (
        <ModeSelectionItem
          key={mode.key}
          mode={mode}
          currentMode={currentMode}
          showDescription={true}
          isApproveModeConfigure={false}
          handleModeChange={handleModeChange}
        />
      ))}
    </div>
  );
};
