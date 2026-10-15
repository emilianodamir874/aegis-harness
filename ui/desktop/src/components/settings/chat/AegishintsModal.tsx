import { useState, useEffect } from 'react';
import { Button } from '../../ui/button';
import { Check } from '../../icons';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';
import { errorMessage } from '../../../utils/conversionUtils';
import { defineMessages, useIntl } from '../../../i18n';

const i18n = defineMessages({
  dialogTitle: {
    id: 'aegishintsModal.dialogTitle',
    defaultMessage: 'Configure Project Hints (.aegishints)',
  },
  dialogDescription: {
    id: 'aegishintsModal.dialogDescription',
    defaultMessage:
      'Provide additional context about your project to improve communication with Aegis',
  },
  helpText1: {
    id: 'aegishintsModal.helpText1',
    defaultMessage:
      '.aegishints is a text file used to provide additional context about your project and improve the communication with Aegis.',
  },
  helpText2: {
    id: 'aegishintsModal.helpText2',
    defaultMessage:
      "Please make sure {bold} extension is enabled in the extensions page. This extension is required to use .aegishints. You'll need to restart your session for .aegishints updates to take effect.",
  },
  helpText3: {
    id: 'aegishintsModal.helpText3',
    defaultMessage: 'See {link} for more information.',
  },
  helpTextLink: {
    id: 'aegishintsModal.helpTextLink',
    defaultMessage: 'using .aegishints',
  },
  errorReading: {
    id: 'aegishintsModal.errorReading',
    defaultMessage: 'Error reading .aegishints file: {error}',
  },
  fileFound: {
    id: 'aegishintsModal.fileFound',
    defaultMessage: '.aegishints file found at: {filePath}',
  },
  fileCreating: {
    id: 'aegishintsModal.fileCreating',
    defaultMessage: 'Creating new .aegishints file at: {filePath}',
  },
  placeholder: {
    id: 'aegishintsModal.placeholder',
    defaultMessage: 'Enter project hints here...',
  },
  savedSuccessfully: {
    id: 'aegishintsModal.savedSuccessfully',
    defaultMessage: 'Saved successfully',
  },
  close: {
    id: 'aegishintsModal.close',
    defaultMessage: 'Close',
  },
  saving: {
    id: 'aegishintsModal.saving',
    defaultMessage: 'Saving...',
  },
  save: {
    id: 'aegishintsModal.save',
    defaultMessage: 'Save',
  },
  failedToAccess: {
    id: 'aegishintsModal.failedToAccess',
    defaultMessage: 'Failed to access .aegishints file',
  },
  failedToSave: {
    id: 'aegishintsModal.failedToSave',
    defaultMessage: 'Failed to save .aegishints file',
  },
  developer: {
    id: 'aegishintsModal.developer',
    defaultMessage: 'Developer',
  },
});

const HelpText = () => {
  const intl = useIntl();

  return (
    <div className="text-sm flex-col space-y-4 text-text-secondary">
      <p>{intl.formatMessage(i18n.helpText1)}</p>
      <p>
        {intl.formatMessage(i18n.helpText2, {
          bold: <span className="font-bold">{intl.formatMessage(i18n.developer)}</span>,
        })}
      </p>
      <p>
        {intl.formatMessage(i18n.helpText3, {
          link: (
            <Button
              variant="link"
              className="text-blue-500 hover:text-blue-600 p-0 h-auto"
              onClick={() =>
                window.open(
                  'https://goose-docs.ai/docs/guides/using-aegishints/',
                  '_blank'
                )
              }
            >
              {intl.formatMessage(i18n.helpTextLink)}
            </Button>
          ),
        })}
      </p>
    </div>
  );
};

const ErrorDisplay = ({ error }: { error: Error }) => {
  const intl = useIntl();

  return (
    <div className="text-sm text-text-secondary">
      <div className="text-red-600">
        {intl.formatMessage(i18n.errorReading, { error: errorMessage(error) })}
      </div>
    </div>
  );
};

const FileInfo = ({ filePath, found }: { filePath: string; found: boolean }) => {
  const intl = useIntl();

  return (
    <div className="text-sm font-medium mb-2">
      {found ? (
        <div className="text-green-600">
          <Check className="w-4 h-4 inline-block" />{' '}
          {intl.formatMessage(i18n.fileFound, { filePath })}
        </div>
      ) : (
        <div>{intl.formatMessage(i18n.fileCreating, { filePath })}</div>
      )}
    </div>
  );
};

interface AegishintsModalProps {
  directory: string;
  setIsAegishintsModalOpen: (isOpen: boolean) => void;
}

export const AegishintsModal = ({ directory, setIsAegishintsModalOpen }: AegishintsModalProps) => {
  const intl = useIntl();
  const aegishintsFilePath = `${directory}/.aegishints`;
  const [aegishintsFile, setAegishintsFile] = useState<string>('');
  const [aegishintsFileFound, setAegishintsFileFound] = useState<boolean>(false);
  const [aegishintsFileReadError, setAegishintsFileReadError] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  useEffect(() => {
    const fetchAegishintsFile = async () => {
      try {
        const { file, error, found } = await window.electron.readAegishints();
        setAegishintsFile(file);
        setAegishintsFileFound(found);
        setAegishintsFileReadError(error ?? '');
      } catch (error) {
        console.error('Error fetching .aegishints file:', error);
        setAegishintsFileReadError(intl.formatMessage(i18n.failedToAccess));
      }
    };
    if (directory) fetchAegishintsFile();
  }, [directory, intl]);

  const writeFile = async () => {
    setIsSaving(true);
    setSaveSuccess(false);
    try {
      const saved = await window.electron.writeAegishints(aegishintsFile);
      if (!saved) {
        throw new Error('Unable to save .aegishints');
      }
      setSaveSuccess(true);
      setAegishintsFileFound(true);
      setTimeout(() => setSaveSuccess(false), 3000);
    } catch (error) {
      console.error('Error writing .aegishints file:', error);
      setAegishintsFileReadError(intl.formatMessage(i18n.failedToSave));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={true} onOpenChange={(open) => setIsAegishintsModalOpen(open)}>
      <DialogContent className="w-[80vw] max-w-[80vw] sm:max-w-[80vw] max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage(i18n.dialogTitle)}</DialogTitle>
          <DialogDescription>{intl.formatMessage(i18n.dialogDescription)}</DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 pt-2 pb-4">
          <HelpText />

          <div>
            {aegishintsFileReadError ? (
              <ErrorDisplay error={new Error(aegishintsFileReadError)} />
            ) : (
              <div className="space-y-2">
                <FileInfo filePath={aegishintsFilePath} found={aegishintsFileFound} />
                <textarea
                  value={aegishintsFile}
                  className="w-full h-80 border rounded-md p-2 text-sm resize-none bg-background-primary text-text-primary border-border-primary focus:outline-none focus:ring-2 focus:ring-blue-500"
                  onChange={(event) => setAegishintsFile(event.target.value)}
                  placeholder={intl.formatMessage(i18n.placeholder)}
                />
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          {saveSuccess && (
            <span className="text-green-600 text-sm flex items-center gap-1 mr-auto">
              <Check className="w-4 h-4" />
              {intl.formatMessage(i18n.savedSuccessfully)}
            </span>
          )}
          <Button variant="outline" onClick={() => setIsAegishintsModalOpen(false)}>
            {intl.formatMessage(i18n.close)}
          </Button>
          <Button onClick={writeFile} disabled={isSaving}>
            {isSaving ? intl.formatMessage(i18n.saving) : intl.formatMessage(i18n.save)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
