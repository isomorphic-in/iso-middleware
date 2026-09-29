/**
 * Default Bot and UI Configurations
 * Directly mapped to ISO Chatbot requirements and MongoDB botUIConfigs schema.
 */

const DEFAULT_BOT_UI_CONFIGS = {
  botThemeColor: '#00306D',
  botChatStartImage: 'https://bbh-product-bucket.s3.us-east-2.amazonaws.com/a04ac944-0efc-4f92-84cd-9463c94f0505.png',
  botResponseBackgroundColor: '#EFEFEF',
  userQueryBackgroundColor: '#EFEFEF',
  botResponseFontColor: '#1F2937',
  userQueryFontColor: '#1F2937',
  bgColor: '#ffffff',
  logoUrl: 'https://bbh-product-bucket.s3.us-east-2.amazonaws.com/a04ac944-0efc-4f92-84cd-9463c94f0505.png',
  botHeaderText: 'Student Services AI',
  DefaultEmptyMessage: 'Type your academic or campus question...',
  helpNotificationRenderTime: 10000,
  helpNotificationRenderMsg: 'Welcome to Student Services AI. I can assist with admissions, financial aid, advising, and campus IT help.',
  idleStatMessages: [
    { message: 'Are you still with us? Please let me know if you need any additional campus assistance.', time: 180 },
    { message: 'This student support session has ended due to inactivity. Please initiate a new session whenever you are ready.', time: 240 }
  ],
  chatPosition: 'fixed',
  chatPositionLeft: 'auto',
  chatAlignmentLeft: false,
  chatPositionRight: '30px',
  chatPositionTop: 'auto',
  chatPositionBottom: '20px',
  chatIconWidth: '90',
  chatIconHeight: '90',
  chatMobileIconWidth: '70',
  chatMobileIconHeight: '70',
  chatMobileVerticalIconWidth: '90',
  chatMobileVerticalIconHeight: '90',
  chatIconAltText: 'Student Services Assistant',
  chatIconTitleText: 'Student Services Assistant',
  allowMultiLangSupport: false,
  demoBackgroundUrl: '',
  likeIcon: 'https://bbh-product-bucket.s3.us-east-2.amazonaws.com/dba2acac-c841-47b7-be3f-106ed4b66fef.png',
  dislikeIcon: 'https://bbh-product-bucket.s3.us-east-2.amazonaws.com/a91652f3-c1f1-4396-8aab-45793777ef09.png',
  botChatSubmitButton: true,
  isChatOpened: false,
  transferFormDelay: 5,
  showThumbUpDownFeedbackform: true,
  showHelpButton: true,
  helpButtonUrl: 'https://vsc.blackbelthelp.com/help',
  poweredBy: 'AI Student Services by <span>Isomorphic</span>',
  welcomeMessage: 'Welcome to Student Services AI. How may I assist you with your academic inquiries, enrollment details, financial aid, or campus resources today?',
  surveySubmitButtonText: 'Submit Feedback',
  surveySubmitButtonColor: '',
  surveySubmitButtonTextColor: '',
  notifications: []
};

const DEFAULT_GREETING_MESSAGE = [
  'Welcome to Student Services AI! I am here to assist you with academic advising, course registration, financial aid, admissions deadlines, and campus technology support. How may I help you today?'
];

const DEFAULT_CUSTOM_FORMS = [
  {
    name: 'transferCall',
    title: 'Connect with a Student Support Advisor',
    fields: [
      { name: 'fullName', label: 'Full Name', type: 'text', required: true },
      { name: 'email', label: 'Institutional Email (.edu / primary)', type: 'email', required: true },
      { name: 'phone', label: 'Phone Number', type: 'tel', required: true },
      { name: 'studentId', label: 'Student ID Number (Optional)', type: 'text', required: false },
      { name: 'notes', label: 'Inquiry Details & Academic Department', type: 'textarea', required: false }
    ],
    submitText: 'Submit Advisor Request',
    postbackUrl: '/api/chat/form-submit'
  },
  {
    name: 'survey',
    title: 'Student Support Feedback & Evaluation',
    fields: [
      { name: 'rating', label: 'Support Quality Rating (1-5)', type: 'number', required: true, min: 1, max: 5 },
      { name: 'comments', label: 'Comments or suggestions to improve our student services', type: 'textarea', required: false }
    ],
    submitText: 'Submit Feedback',
    postbackUrl: '/api/chat/form-submit'
  }
];

module.exports = {
  DEFAULT_BOT_UI_CONFIGS,
  DEFAULT_GREETING_MESSAGE,
  DEFAULT_CUSTOM_FORMS
};
