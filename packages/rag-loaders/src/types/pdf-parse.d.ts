declare module 'pdf-parse' {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: Record<string, unknown>;
    metadata: Record<string, unknown> | null;
    text: string;
    version: string;
  }

  function pdfParse(
    dataBuffer: Buffer | ArrayBuffer,
    options?: Record<string, unknown>,
  ): Promise<PdfParseResult>;

  export = pdfParse;
}
