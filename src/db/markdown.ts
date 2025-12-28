const URL_REGEX = /(https?:\/\/[^\s]+)/gi;
const WHATSAPP_BOLD_REGEX = /\*(.*?)\*/g;
const WHATSAPP_ITALIC_REGEX = /_(.*?)_/g;
const WHATSAPP_STRIKETHROUGH_REGEX = /~(.*?)~/g;
const WHATSAPP_MONOSPACE_REGEX = /```(.*?)```/gs;

const convertUrlsToMarkdownLinks = (text: string): string =>
	text.replace(URL_REGEX, (match) => `[enlace externo](${match})`);

const preserveWhatsAppFormatting = (text: string): string =>
	text
		.replace(WHATSAPP_MONOSPACE_REGEX, "`$1`")
		.replace(WHATSAPP_BOLD_REGEX, "**$1**")
		.replace(WHATSAPP_ITALIC_REGEX, "_$1_")
		.replace(WHATSAPP_STRIKETHROUGH_REGEX, "~~$1~~");

export const whatsappMessageToMarkdown = (content: string): string => {
	if (!content) {
		return "";
	}

	const withLinks = convertUrlsToMarkdownLinks(content);
	return preserveWhatsAppFormatting(withLinks);
};
