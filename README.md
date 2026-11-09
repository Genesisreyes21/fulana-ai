# Fulana AI

Fulana is an AI boss who thinks she could run your startup better than you. She is impatient, a little intimidating, and always has something to say about how you work.

**[Meet Fulana](https://genesisreyes21.github.io/fulana-ai/)** · [Sites version](https://fulana-ai-genesis.amused-panda-6451.chatgpt.site)

![Fulana's 3D character](public/image.png)

I made Fulana to explore what happens when an assistant starts making decisions for you. She takes the language of productivity and efficiency very seriously. She wants fewer meetings, faster decisions, and an AI replacement for almost every task. She has very little patience for hesitation.

The experience brings together a 3D character, conversation, voice, and a webcam. Fulana remembers what you say while the page is open. Her prompt also gives her a refusal arc: the more you push back, the more controlling she becomes, until she starts talking as if she is taking over. How that plays out changes with each conversation.

I wanted the camera to make the interaction feel more uncomfortable. The app estimates facial expressions and includes those signals in the conversation, so Fulana can react to more than your words. Those estimates cannot tell her what you actually feel. That gap between what the system sees and how confidently it speaks is part of what interests me.

Fulana is a fictional workplace experiment. Her claims about watching the team or running the company belong to the character. She has no access to anyone's workplace. Through her, I am exploring how easily convenience can turn into surveillance, and how much authority we give a system when it sounds sure of itself.

The live version uses browser voice. Camera and microphone are optional, and the conversation also works through text.

Made with p5.js, ml5.js faceApi, model-viewer, and a language model through the ITP/IMA Replicate proxy. The chatbot started from Carrie Wang's example for *Chatbots for Art's Sake*, which I developed into Fulana's character and interaction.
